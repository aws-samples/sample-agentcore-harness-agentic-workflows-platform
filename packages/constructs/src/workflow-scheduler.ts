/**
 * WorkflowScheduler — the fixed scheduling infrastructure.
 *
 * Provisions everything that must exist at deploy time so the app can create
 * per-workflow EventBridge schedules at runtime with zero control-plane
 * authority: a schedule group, ONE pre-created scheduler role (the only role
 * the app may pass), a DLQ, and a failure alarm. The scheduler role can start
 * exactly one state machine — the plan interpreter.
 */
import { Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface WorkflowSchedulerProps {
  /** The plan interpreter state machine — the role's ONLY allowed target. */
  readonly stateMachine: sfn.IStateMachine;
  /** Schedule group name. Default: derived from the construct path. */
  readonly scheduleGroupName?: string;
}

export class WorkflowScheduler extends Construct {
  public readonly schedulerRole: iam.Role;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly scheduleGroup: scheduler.CfnScheduleGroup;
  public readonly failureAlarm: cloudwatch.Alarm;
  public readonly stateMachineArn: string;

  constructor(scope: Construct, id: string, props: WorkflowSchedulerProps) {
    super(scope, id);

    this.stateMachineArn = props.stateMachine.stateMachineArn;

    this.scheduleGroup = new scheduler.CfnScheduleGroup(this, 'Group', {
      ...(props.scheduleGroupName ? { name: props.scheduleGroupName } : {}),
    });

    // Confused-deputy guard: only Scheduler in THIS account may assume.
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.PrincipalWithConditions(
        new iam.ServicePrincipal('scheduler.amazonaws.com'),
        { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
      ),
      description:
        'Fixed role for runtime-created workflow schedules; may only start the plan interpreter',
    });
    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [this.stateMachineArn],
      }),
    );

    this.deadLetterQueue = new sqs.Queue(this, 'Dlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.deadLetterQueue.grantSendMessages(this.schedulerRole);

    this.failureAlarm = new cloudwatch.Alarm(this, 'DlqAlarm', {
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        'A scheduled workflow run failed to start (message in scheduler DLQ)',
    });
  }

  /**
   * Environment variables for the API runtime — everything it needs to create
   * per-workflow schedules, and nothing more.
   */
  public runtimeEnvironment(): Record<string, string> {
    return {
      STATE_MACHINE_ARN: this.stateMachineArn,
      SCHEDULER_ROLE_ARN: this.schedulerRole.roleArn,
      SCHEDULE_GROUP_NAME: this.scheduleGroup.ref,
      SCHEDULER_DLQ_ARN: this.deadLetterQueue.queueArn,
    };
  }

  /**
   * Grant an API principal the narrow runtime surface: manage schedules in
   * this group + pass the fixed scheduler role + start/read executions.
   */
  public grantManageSchedules(grantee: iam.IGrantable): void {
    const stack = Stack.of(this);
    const groupName = this.scheduleGroup.ref;
    iam.Grant.addToPrincipal({
      grantee,
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:UpdateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:GetSchedule',
        'scheduler:ListSchedules',
      ],
      resourceArns: [
        stack.formatArn({
          service: 'scheduler',
          resource: 'schedule',
          resourceName: `${groupName}/*`,
        }),
      ],
    });
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['iam:PassRole'],
      resourceArns: [this.schedulerRole.roleArn],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
      },
    });
  }
}
