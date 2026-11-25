import {
  CloudUploadOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Layout, Menu, Space, Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { primaryRole, useAuthStore } from '@/features/auth/authStore';
import { useCan, type Permission } from '@/features/auth/permissions';
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
  { path: '/cases', icon: <FolderOpenOutlined />, labelKey: 'nav.cases' },
  { path: '/upload', icon: <CloudUploadOutlined />, labelKey: 'nav.upload', permission: 'upload' },
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
  const logout = useLogout();
  const can = useCan();
  const role = primaryRole(user);

  const navItems = NAV_ITEMS.filter((i) => !i.permission || can(i.permission));
  const selected = navItems.find((i) => location.pathname.startsWith(i.path))?.path;

  return (
    <Layout className="app-shell">
      <DemoBanner />
      <Layout className="app-shell__main">
        <Layout.Sider className="app-sider" width={208} breakpoint="lg" collapsedWidth={64}>
          <Link to="/cases" className="app-sider__brand">
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
            items={navItems.map((i) => ({ key: i.path, icon: i.icon, label: t(i.labelKey) }))}
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
              <Space size={8}>
                <Avatar size="small" icon={<UserOutlined />} />
                <span className="app-header__user">{user?.fullName ?? user?.username}</span>
                {role && <Tag color="cyan">{t(`roles.${role}`)}</Tag>}
              </Space>
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
