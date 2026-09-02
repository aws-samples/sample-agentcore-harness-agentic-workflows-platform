/**
 * Application shell: TopNavigation + AppLayout with side navigation,
 * breadcrumbs and flash notifications. Dark sidebar + header bar + recents
 * rail, built on Cloudscape AppLayout/SideNavigation/TopNavigation.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import AppLayout from '@cloudscape-design/components/app-layout';
import Badge from '@cloudscape-design/components/badge';
import BreadcrumbGroup, {
  type BreadcrumbGroupProps,
} from '@cloudscape-design/components/breadcrumb-group';
import Flashbar, { type FlashbarProps } from '@cloudscape-design/components/flashbar';
import SideNavigation, {
  type SideNavigationProps,
} from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import { isDarkMode, setDarkMode } from '../appearance';
import { displayName, signOut } from '../auth';
import { useRecents } from '../recents';

export interface FlashMessage {
  type: 'success' | 'error' | 'info' | 'warning';
  header?: ReactNode;
  content: ReactNode;
}

interface ShellApi {
  /** Pages set their own breadcrumb trail (root crumb is added for them). */
  setBreadcrumbs: (items: BreadcrumbGroupProps.Item[]) => void;
  /** Push a flash notification; successes auto-dismiss after 5 s. */
  notify: (message: FlashMessage) => void;
}

const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const context = useContext(ShellContext);
  if (!context) {
    throw new Error('useShell must be used inside AppShell');
  }
  return context;
}

function activeHrefFor(pathname: string): string {
  if (pathname === '/') return '/';
  if (pathname.startsWith('/workflows') || pathname.startsWith('/runs')) return '/workflows';
  if (pathname.startsWith('/artifacts')) return '/artifacts';
  if (pathname.startsWith('/insights')) return '/insights';
  if (pathname.startsWith('/settings')) return '/settings';
  return pathname;
}

const SUCCESS_DISMISS_MS = 5_000;

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const recents = useRecents();
  const user = useMemo(() => displayName(), []);

  const [dark, setDark] = useState(isDarkMode);
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [breadcrumbs, setBreadcrumbsState] = useState<BreadcrumbGroupProps.Item[]>([]);
  const [flashItems, setFlashItems] = useState<FlashbarProps.MessageDefinition[]>([]);
  const flashId = useRef(0);

  const dismissFlash = useCallback((id: string) => {
    setFlashItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(
    (message: FlashMessage) => {
      const id = `flash-${(flashId.current += 1)}`;
      // Newest first: the stacked Flashbar shows item 0 and collapses the
      // rest, so appending would hide fresh messages behind an older sticky
      // error (found by the browser smoke test — a success saved after a
      // failed attempt was invisible).
      setFlashItems((current) => [
        {
          id,
          type: message.type,
          header: message.header,
          content: message.content,
          dismissible: true,
          onDismiss: () => dismissFlash(id),
        },
        ...current,
      ]);
      if (message.type === 'success') {
        window.setTimeout(() => dismissFlash(id), SUCCESS_DISMISS_MS);
      }
    },
    [dismissFlash],
  );

  const setBreadcrumbs = useCallback((items: BreadcrumbGroupProps.Item[]) => {
    setBreadcrumbsState([{ text: 'Agentic Workflows', href: '/' }, ...items]);
  }, []);

  const shellApi = useMemo<ShellApi>(() => ({ setBreadcrumbs, notify }), [setBreadcrumbs, notify]);

  const navItems = useMemo<SideNavigationProps['items']>(() => {
    const items: SideNavigationProps.Item[] = [
      { type: 'link', text: 'Dashboard', href: '/' },
      { type: 'link', text: 'Workflows', href: '/workflows' },
      { type: 'divider' },
      // Preview pages: backend support not implemented yet (see page copy).
      { type: 'link', text: 'Artifact library', href: '/artifacts', info: <Badge color="blue">Soon</Badge> },
      { type: 'link', text: 'Insights', href: '/insights', info: <Badge color="blue">Soon</Badge> },
      { type: 'divider' },
      { type: 'link', text: 'Settings', href: '/settings' },
    ];
    if (recents.length > 0) {
      items.push({ type: 'divider' });
      items.push({
        type: 'section',
        text: 'Recently viewed',
        items: recents.map((entry) => ({ type: 'link', text: entry.name, href: entry.href })),
      });
    }
    return items;
  }, [recents]);

  return (
    <ShellContext.Provider value={shellApi}>
      <div id="app-top-nav" style={{ position: 'sticky', top: 0, zIndex: 1002 }}>
        <TopNavigation
          identity={{
            href: '/',
            title: 'Agentic Workflows',
            onFollow: (event) => {
              event.preventDefault();
              navigate('/');
            },
          }}
          utilities={[
            {
              type: 'button',
              text: dark ? 'Light mode' : 'Dark mode',
              onClick: () => {
                setDarkMode(!dark);
                setDark(!dark);
              },
            },
            {
              type: 'menu-dropdown',
              text: user,
              iconName: 'user-profile',
              items: [
                { id: 'settings', text: 'Settings' },
                { id: 'signout', text: 'Sign out' },
              ],
              onItemClick: (event) => {
                if (event.detail.id === 'signout') {
                  signOut();
                  navigate('/login');
                } else if (event.detail.id === 'settings') {
                  navigate('/settings');
                }
              },
            },
          ]}
        />
      </div>
      <AppLayout
        headerSelector="#app-top-nav"
        toolsHide
        navigationOpen={navigationOpen}
        onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
        ariaLabels={{
          navigation: 'Navigation',
          navigationToggle: 'Open navigation',
          navigationClose: 'Close navigation',
          notifications: 'Notifications',
        }}
        navigation={
          <SideNavigation
            header={{ href: '/', text: 'Agentic Workflows' }}
            activeHref={activeHrefFor(location.pathname)}
            items={navItems}
            onFollow={(event) => {
              if (!event.detail.external) {
                event.preventDefault();
                navigate(event.detail.href);
              }
            }}
          />
        }
        breadcrumbs={
          breadcrumbs.length > 1 ? (
            <BreadcrumbGroup
              items={breadcrumbs}
              onFollow={(event) => {
                event.preventDefault();
                navigate(event.detail.href);
              }}
            />
          ) : undefined
        }
        notifications={
          flashItems.length > 0 ? (
            <Flashbar
              items={flashItems}
              stackItems
              i18nStrings={{
                ariaLabel: 'Notifications',
                notificationBarText: 'Notifications',
                notificationBarAriaLabel: 'View all notifications',
                errorIconAriaLabel: 'Error',
                successIconAriaLabel: 'Success',
                warningIconAriaLabel: 'Warning',
                infoIconAriaLabel: 'Info',
              }}
            />
          ) : undefined
        }
        content={<Outlet />}
      />
    </ShellContext.Provider>
  );
}
