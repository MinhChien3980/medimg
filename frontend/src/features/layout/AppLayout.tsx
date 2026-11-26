import {
  AppstoreOutlined,
  AuditOutlined,
  CloudUploadOutlined,
  DashboardOutlined,
  DownOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  LogoutOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  Avatar,
  Button,
  Dropdown,
  Layout,
  Menu,
  Space,
  Tag,
  Tooltip,
  Typography,
  type MenuProps,
} from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { primaryRole, selectPasswordChangeRequired, useAuthStore } from '@/features/auth/authStore';
import { useCan, type Permission } from '@/features/auth/permissions';
import { CHANGE_PASSWORD_PATH, HOME_PATH } from '@/features/auth/redirects';
import { useLogout } from '@/features/auth/session';
import { ErrorBoundary } from '@/shared/components/ErrorBoundary';
import type { Messages } from '@/i18n/locales/vi';
import { LanguageSwitch } from './LanguageSwitch';

interface NavItem {
  path: string;
  icon: ReactNode;
  labelKey: `nav.${keyof Messages['nav']}`;
  /** Shown only to users with this permission. */
  permission?: Permission;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard', icon: <DashboardOutlined />, labelKey: 'nav.dashboard' },
  { path: '/cases', icon: <FolderOpenOutlined />, labelKey: 'nav.cases' },
  { path: '/samples', icon: <AppstoreOutlined />, labelKey: 'nav.samples' },
  { path: '/upload', icon: <CloudUploadOutlined />, labelKey: 'nav.upload', permission: 'upload' },
];

/** The Administration group (admins only). */
const ADMIN_ITEMS: NavItem[] = [
  { path: '/admin/users', icon: <TeamOutlined />, labelKey: 'nav.users' },
  { path: '/admin/models', icon: <ExperimentOutlined />, labelKey: 'nav.models' },
  { path: '/admin/audit', icon: <AuditOutlined />, labelKey: 'nav.audit' },
];

export function DemoBanner() {
  const { t } = useTranslation();
  return (
    <div className="demo-banner" role="note">
      {t('banner.demo')}
    </div>
  );
}

export default function AppLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  // While a temporary password must be replaced, nothing else is offered.
  const mustChangePassword = useAuthStore(selectPasswordChangeRequired);
  const logout = useLogout();
  const can = useCan();
  const role = primaryRole(user);

  const navItems = mustChangePassword
    ? []
    : NAV_ITEMS.filter((i) => !i.permission || can(i.permission));
  const adminItems = mustChangePassword || !can('administer') ? [] : ADMIN_ITEMS;
  const selected = [...navItems, ...adminItems]
    .filter((i) => location.pathname === i.path || location.pathname.startsWith(`${i.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;

  const toMenuItem = (i: NavItem) => ({ key: i.path, icon: i.icon, label: t(i.labelKey) });
  const menuItems: MenuProps['items'] = [
    ...navItems.map(toMenuItem),
    ...(adminItems.length > 0
      ? [{ type: 'group' as const, label: t('nav.admin'), children: adminItems.map(toMenuItem) }]
      : []),
  ];

  const accountItems: MenuProps['items'] = [
    { key: 'password', icon: <KeyOutlined />, label: t('header.changePassword') },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: t('header.logout') },
  ];
  const onAccountClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'password') void navigate(CHANGE_PASSWORD_PATH);
    if (key === 'logout') void logout();
  };

  return (
    <Layout className="app-shell">
      <DemoBanner />
      <Layout className="app-shell__main">
        <Layout.Sider className="app-sider" width={208} breakpoint="lg" collapsedWidth={64}>
          <Link to={HOME_PATH} className="app-sider__brand">
            <span className="brand-mark brand-mark--small" aria-hidden>
              <svg viewBox="0 0 32 32" width="22" height="22">
                <path
                  d="M6 16h5l2.5-7 5 14 2.5-7h5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="app-sider__name">{t('common.appName')}</span>
          </Link>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={selected ? [selected] : []}
            items={menuItems}
            onClick={({ key }) => void navigate(key)}
          />
        </Layout.Sider>
        <Layout>
          <Layout.Header className="app-header">
            <Typography.Text type="secondary" className="app-header__tagline">
              {t('common.appTagline')}
            </Typography.Text>
            <Space size="middle">
              <LanguageSwitch />
              <Dropdown menu={{ items: accountItems, onClick: onAccountClick }} trigger={['click']}>
                <Button
                  type="text"
                  className="app-header__account"
                  aria-label={t('header.account')}
                  title={t('header.account')}
                >
                  <Space size={8}>
                    <Avatar size="small" icon={<UserOutlined />} />
                    <span className="app-header__user">{user?.fullName ?? user?.username}</span>
                    {role && <Tag color="cyan">{t(`roles.${role}`)}</Tag>}
                    <DownOutlined />
                  </Space>
                </Button>
              </Dropdown>
              <Tooltip title={t('header.logout')}>
                <Button
                  icon={<LogoutOutlined />}
                  aria-label={t('header.logout')}
                  onClick={() => void logout()}
                />
              </Tooltip>
            </Space>
          </Layout.Header>
          <Layout.Content className="app-content">
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </Layout.Content>
        </Layout>
      </Layout>
    </Layout>
  );
}
