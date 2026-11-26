import {
  ExperimentOutlined,
  EyeOutlined,
  CloudUploadOutlined,
  UserOutlined,
  LockOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router';
import type { LoginRequest } from '@/api/types';
import { LanguageSwitch } from '@/features/layout/LanguageSwitch';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { selectIsAuthenticated, useAuthStore } from './authStore';
import { returnTarget } from './redirects';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, useLogin } from './session';

export default function LoginPage() {
  const { t } = useTranslation();
  const [form] = Form.useForm<LoginRequest>();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const sessionRevoked = useAuthStore((s) => s.sessionRevoked);
  const passwordChangedSignIn = useAuthStore((s) => s.passwordChangedSignIn);
  const target = returnTarget(location.state);

  if (isAuthenticated && !login.isPending) return <Navigate to={target} replace />;

  const onFinish = (values: LoginRequest) => {
    login.mutate(values, { onSuccess: () => void navigate(target, { replace: true }) });
  };

  const fillDemo = (username: string) => {
    form.setFieldsValue({ username, password: DEMO_PASSWORD });
    login.reset();
  };

  return (
    <div className="login-page">
      <div className="demo-banner demo-banner--static" role="note">
        {t('banner.demo')}
      </div>
      <div className="login-page__body">
        <section className="login-page__brand">
          <div className="brand-mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="40" height="40">
              <path
                d="M6 16h5l2.5-7 5 14 2.5-7h5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1>{t('common.appName')}</h1>
          <p className="login-page__tagline">{t('auth.subtitle')}</p>
          <ul className="login-page__features">
            <li>
              <CloudUploadOutlined /> {t('auth.features.upload')}
            </li>
            <li>
              <ExperimentOutlined /> {t('auth.features.ai')}
            </li>
            <li>
              <EyeOutlined /> {t('auth.features.viewer')}
            </li>
          </ul>
        </section>

        <section className="login-page__form">
          <div className="login-page__lang">
            <LanguageSwitch />
          </div>
          <Card variant="borderless" className="login-card">
            <Typography.Title level={3} style={{ marginTop: 0 }}>
              {t('auth.title')}
            </Typography.Title>

            {passwordChangedSignIn && !login.isError && (
              <Alert
                type="success"
                showIcon
                title={t('auth.passwordChanged')}
                style={{ marginBottom: 16 }}
              />
            )}
            {sessionRevoked && !login.isError && (
              <Alert
                type="warning"
                showIcon
                title={t('auth.sessionRevoked')}
                style={{ marginBottom: 16 }}
              />
            )}
            {sessionExpired && !passwordChangedSignIn && !login.isError && (
              <Alert
                type="warning"
                showIcon
                title={t('auth.sessionExpired')}
                style={{ marginBottom: 16 }}
              />
            )}
            {login.isError && (
              <ProblemAlert
                error={login.error}
                title={t('auth.loginFailed')}
                style={{ marginBottom: 16 }}
              />
            )}

            <Form<LoginRequest>
              form={form}
              layout="vertical"
              onFinish={onFinish}
              requiredMark={false}
              autoComplete="on"
            >
              <Form.Item
                name="username"
                label={t('auth.username')}
                rules={[{ required: true, whitespace: true, message: t('auth.usernameRequired') }]}
              >
                <Input prefix={<UserOutlined />} autoComplete="username" autoFocus />
              </Form.Item>
              <Form.Item
                name="password"
                label={t('auth.password')}
                rules={[{ required: true, message: t('auth.passwordRequired') }]}
              >
                <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block size="large" loading={login.isPending}>
                {t('auth.submit')}
              </Button>
            </Form>

            <div className="demo-accounts">
              <Typography.Text strong>{t('auth.demoAccounts')}</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '2px 0 8px' }}>
                {t('auth.demoHint', { password: DEMO_PASSWORD })}
              </Typography.Paragraph>
              <div className="demo-accounts__list">
                {DEMO_ACCOUNTS.map((a) => (
                  <button
                    key={a.username}
                    type="button"
                    className="demo-account"
                    onClick={() => fillDemo(a.username)}
                  >
                    <span className="demo-account__name">{a.username}</span>
                    <Tag variant="filled" color="geekblue">
                      {t(`roles.${a.role}`)}
                    </Tag>
                  </button>
                ))}
              </div>
            </div>
          </Card>
        </section>
      </div>
    </div>
  );
}
