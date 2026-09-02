/**
 * ObservabilityPack — per-workload dashboard + alarms.
 *
 * Harness invocations are auto-traced by AgentCore Observability; this pack
 * adds the workload-level view: interpreter executions, failures, duration,
 * and the scheduler DLQ.
 */
import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface ObservabilityPackProps {
  readonly workloadName: string;
  readonly stateMachine: sfn.IStateMachine;
  readonly deadLetterQueue?: sqs.IQueue;
  /** Optional email subscription for the alarm topic. */
  readonly alarmEmail?: string;
}

export class ObservabilityPack extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly executionFailureAlarm: cloudwatch.Alarm;
  /**
   * Notification target for every workload alarm (WA review: alarms
   * previously had no actions). Subscribe on-call/email/chat here.
   * Unencrypted by design: payloads are alarm state changes, and
   * CloudWatch cannot publish to topics using the AWS-managed SNS key.
   */
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityPackProps) {
    super(scope, id);

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `${props.workloadName} workload alarms`,
    });
    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(
        new subscriptions.EmailSubscription(props.alarmEmail),
      );
    }

    this.executionFailureAlarm = new cloudwatch.Alarm(this, 'ExecutionsFailed', {
      metric: props.stateMachine.metricFailed({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `${props.workloadName}: a workflow run failed`,
    });
    this.executionFailureAlarm.addAlarmAction(
      new actions.SnsAction(this.alarmTopic),
    );

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.workloadName}-agentic-workload`,
    });
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Workflow runs',
        left: [
          props.stateMachine.metricStarted({ period: Duration.minutes(5) }),
          props.stateMachine.metricSucceeded({ period: Duration.minutes(5) }),
          props.stateMachine.metricFailed({ period: Duration.minutes(5) }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Run duration',
        left: [props.stateMachine.metricTime({ period: Duration.minutes(5) })],
        width: 12,
      }),
    );
    if (props.deadLetterQueue) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Scheduler dead letters',
          left: [
            props.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
          ],
          width: 12,
        }),
      );
    }
  }
}
