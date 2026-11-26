import { CheckOutlined, LockOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, Typography } from 'antd';
import type { Rule } from 'antd/es/form';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { accountApi } from '@/api/endpoints';
import { refreshAccessToken, SessionExpiredError } from '@/api/http';
import { toAppError } from '@/api/problem';
import { selectPasswordChangeRequired, useAuthStore } from '@/features/auth/authStore';
import { returnTarget } from '@/features/auth/redirects';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { serverFieldErrors } from '@/shared/lib/formErrors';
import { passwordViolations, type PasswordViolation } from './passwordPolicy';

interface PasswordForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const FIELDS = ['currentPassword', 'newPassword'] as const;

/**
 * `/account/password`. Reached from the account menu, or forced: while the user must replace a
 * temporary password every route redirects here (see `RequireAuth`) and the page offers nothing
 * else. After the change the session is renewed, so a new access token is used from then on; if
 * the server ended the session instead, the user signs in again with the new password.
 */
export default function ChangePasswordPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm<PasswordForm>();
  const forced = useAuthStore(selectPasswordChangeRequired);
  const username = useAuthStore((s) => s.user?.username);

  const change = useMutation({
    mutationFn: (values: PasswordForm) =>
      accountApi.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
  });

  const onFinish = (values: PasswordForm) => {
    const wasForced = forced;
    const afterChange = async () => {
      try {
        // A new access token, so nothing still carries the old "change required" state.
        await refreshAccessToken();
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          // The server ended this session too: the login page says why.
          useAuthStore.getState().signOutAfterPasswordChange();
          return;
        }
        // Offline for a moment: the session stays, the next request refreshes as usual.
      }
      useAuthStore.getState().passwordChanged();
      form.resetFields();
      void message.success(t('account.changed'));
      if (wasForced) void navigate(returnTarget(location.state), { replace: true });
    };
    change.mutate(values, {
      onSuccess: () => void afterChange(),
      onError: (error) => {
        const fields = serverFieldErrors(error, FIELDS);
        if (fields.length > 0) {
          form.setFields(fields);
        } else if (toAppError(error).status === 422) {
          // core-service answers a wrong current password with a 422 (a 401 would log out).
          form.setFields([{ name: 'currentPassword', errors: [t('account.wrongCurrent')] }]);
        }
      },
    });
  };

  const policyRule = (violation: PasswordViolation, text: string): Rule => ({
    validator: (_rule, value: unknown) => {
      if (typeof value !== 'string' || value === '') return Promise.resolve();
      const current = form.getFieldValue('currentPassword') as string | undefined;
      return passwordViolations(value, { currentPassword: current, username }).includes(violation)
        ? Promise.reject(new Error(text))
        : Promise.resolve();
    },
  });

  // Field errors are shown on their field; anything else (5xx, network) above the form.
  const generalError =
    change.isError &&
    serverFieldErrors(change.error, FIELDS).length === 0 &&
    toAppError(change.error).status !== 422;

  return (
    <div className="page page--narrow">
      <Card className="password-card">
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          <LockOutlined aria-hidden /> {forced ? t('account.forcedTitle') : t('account.title')}
        </Typography.Title>
        {forced && (
          <Alert
            type="warning"
            showIcon
            title={t('account.forcedBody')}
            style={{ marginBottom: 16 }}
          />
        )}
        {generalError && <ProblemAlert error={change.error} style={{ marginBottom: 16 }} />}

        <div className="password-policy" id="password-policy">
          <Typography.Text strong>{t('account.policyTitle')}</Typography.Text>
          <ul>
            {(['length', 'letterDigit', 'differs', 'username'] as const).map((rule) => (
              <li key={rule}>
                <CheckOutlined aria-hidden /> {t(`account.policy.${rule}`)}
              </li>
            ))}
          </ul>
        </div>

        <Form<PasswordForm>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={onFinish}
          disabled={change.isPending}
        >
          {/* Lets password managers attach the new password to the right account. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={username ?? ''}
            readOnly
            hidden
          />
          <Form.Item
            name="currentPassword"
            label={t('account.current')}
            rules={[{ required: true, message: t('account.currentRequired') }]}
          >
            <Input.Password autoComplete="current-password" autoFocus />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label={t('account.newPassword')}
            dependencies={['currentPassword']}
            rules={[
              { required: true, message: t('account.newRequired') },
              policyRule('length', t('account.errors.length')),
              policyRule('letter', t('account.errors.letter')),
              policyRule('digit', t('account.errors.digit')),
              policyRule('same', t('account.errors.same')),
              policyRule('username', t('account.errors.username')),
            ]}
          >
            <Input.Password autoComplete="new-password" aria-describedby="password-policy" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label={t('account.confirm')}
            dependencies={['newPassword']}
            rules={[
              { required: true, message: t('account.confirmRequired') },
              ({ getFieldValue }) => ({
                validator: (_rule, value: unknown) =>
                  !value || value === getFieldValue('newPassword')
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('account.mismatch'))),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={change.isPending}>
            {t('account.submit')}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
