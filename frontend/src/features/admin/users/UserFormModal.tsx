import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Form, Input, Modal, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminUsersApi } from '@/api/endpoints';
import { toAppError } from '@/api/problem';
import {
  ROLES,
  type AdminUserDto,
  type CreateUserResponse,
  type Role,
  type UserDto,
} from '@/api/types';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { serverFieldErrors } from '@/shared/lib/formErrors';
import { demoteBlock } from './userRules';

/** core-service: 3–50 of lowercase letters, digits, dot, underscore, hyphen. */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,50}$/;
export const FULL_NAME_MAX = 100;
const EMAIL_MAX = 254;

export type UserFormMode = { kind: 'create' } | { kind: 'edit'; user: AdminUserDto };

interface UserFormValues {
  username: string;
  fullName: string;
  email?: string;
  roles: Role[];
}

const FIELDS = ['username', 'fullName', 'email', 'roles'] as const;

type SaveOutcome =
  { kind: 'edit'; user: AdminUserDto } | { kind: 'create'; result: CreateUserResponse };

interface Props {
  mode: UserFormMode;
  me: UserDto | null;
  activeAdmins: number | null;
  onClose: () => void;
  onCreated: (result: CreateUserResponse) => void;
  onSaved: (user: AdminUserDto) => void;
  /** Reads the user again (after a 409); null when they are gone from the list. */
  reload: (id: string) => Promise<AdminUserDto | null>;
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/**
 * Create / edit dialog. The parent mounts it per opening (keyed by the user), so every opening
 * starts from the row as listed.
 */
export function UserFormModal({
  mode,
  me,
  activeAdmins,
  onClose,
  onCreated,
  onSaved,
  reload,
}: Props) {
  const { t } = useTranslation();
  const [form] = Form.useForm<UserFormValues>();
  const editing = mode.kind === 'edit' ? mode.user : null;
  // The version the next PUT sends: the edited user's, or the one read again after a 409.
  const [version, setVersion] = useState<number | null>(editing?.version ?? null);
  const [conflict, setConflict] = useState<{ detail: string } | null>(null);
  const [gone, setGone] = useState(false);
  const [reloading, setReloading] = useState(false);

  const save = useMutation({
    // The create response holds the temporary password: keep it out of the mutation cache.
    gcTime: 0,
    mutationFn: (values: UserFormValues): Promise<SaveOutcome> => {
      const fullName = values.fullName.trim();
      const email = trimmed(values.email);
      if (editing) {
        return adminUsersApi
          .update(editing.id, {
            fullName,
            email,
            roles: values.roles,
            version: version ?? editing.version,
          })
          .then((user) => ({ kind: 'edit' as const, user }));
      }
      return adminUsersApi
        .create({ username: values.username, fullName, email, roles: values.roles })
        .then((result) => ({ kind: 'create' as const, result }));
    },
    onSuccess: (outcome) => {
      if (outcome.kind === 'edit') onSaved(outcome.user);
      else onCreated(outcome.result);
      save.reset();
    },
    onError: (error) => {
      const e = toAppError(error);
      if (e.status === 409 && !editing) {
        // Usernames are unique ignoring case.
        form.setFields([{ name: 'username', errors: [t('admin.users.form.usernameTaken')] }]);
        return;
      }
      if (e.status === 409 && editing) {
        // A stale version (someone saved meanwhile), or a rule that changed under our feet
        // (e.g. this became the last active admin): the server says which.
        setConflict({ detail: e.detail });
        return;
      }
      const fields = serverFieldErrors(error, FIELDS);
      if (fields.length > 0) form.setFields(fields);
    },
  });

  const close = () => {
    save.reset();
    onClose();
  };

  const reloadUser = async () => {
    if (!editing) return;
    setReloading(true);
    try {
      const fresh = await reload(editing.id);
      if (!fresh) {
        setGone(true);
        return;
      }
      setVersion(fresh.version);
      form.setFieldsValue({
        fullName: fresh.fullName,
        email: fresh.email ?? undefined,
        roles: fresh.roles,
      });
      setConflict(null);
      save.reset();
    } finally {
      setReloading(false);
    }
  };

  const adminBlock = editing ? demoteBlock(editing, me, activeAdmins) : null;
  const fieldErrorsShown =
    save.isError &&
    (serverFieldErrors(save.error, FIELDS).length > 0 || toAppError(save.error).status === 409);

  return (
    <Modal
      open
      title={
        editing
          ? t('admin.users.form.editTitle', { username: editing.username })
          : t('admin.users.form.createTitle')
      }
      okText={editing ? t('admin.users.form.save') : t('admin.users.form.create')}
      cancelText={t('common.cancel')}
      confirmLoading={save.isPending}
      okButtonProps={{ disabled: gone || conflict !== null }}
      onOk={() => form.submit()}
      onCancel={close}
    >
      {conflict && (
        <Alert
          type="warning"
          showIcon
          role="alert"
          style={{ marginBottom: 16 }}
          title={conflict.detail || t('admin.users.form.conflict')}
          description={t('admin.users.form.conflict')}
          action={
            <Button size="small" loading={reloading} onClick={() => void reloadUser()}>
              {t('admin.users.form.reload')}
            </Button>
          }
        />
      )}
      {gone && (
        <Alert
          type="error"
          showIcon
          role="alert"
          style={{ marginBottom: 16 }}
          title={t('admin.users.form.gone')}
        />
      )}
      {save.isError && !fieldErrorsShown && (
        <ProblemAlert error={save.error} style={{ marginBottom: 16 }} />
      )}
      <Form<UserFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => save.mutate(values)}
        initialValues={
          editing
            ? {
                fullName: editing.fullName,
                email: editing.email ?? undefined,
                roles: editing.roles,
              }
            : { roles: [] }
        }
      >
        {editing ? (
          <Form.Item label={t('admin.users.form.username')}>
            <Typography.Text code>{editing.username}</Typography.Text>
          </Form.Item>
        ) : (
          <Form.Item
            name="username"
            label={t('admin.users.form.username')}
            extra={t('admin.users.form.usernameHelp')}
            normalize={(value: string) => value.toLowerCase()}
            rules={[
              { required: true, message: t('admin.users.form.usernameRequired') },
              { pattern: USERNAME_PATTERN, message: t('admin.users.form.usernamePattern') },
            ]}
          >
            <Input maxLength={50} autoComplete="off" spellCheck={false} />
          </Form.Item>
        )}
        <Form.Item
          name="fullName"
          label={t('admin.users.form.fullName')}
          rules={[
            { required: true, whitespace: true, message: t('admin.users.form.fullNameRequired') },
            {
              max: FULL_NAME_MAX,
              transform: (v: string | undefined) => v?.trim(),
              message: t('admin.users.form.fullNameMax'),
            },
          ]}
        >
          <Input maxLength={FULL_NAME_MAX} autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="email"
          label={t('admin.users.form.email')}
          rules={[
            {
              type: 'email',
              transform: (v: string | undefined) => v?.trim(),
              message: t('admin.users.form.emailInvalid'),
            },
          ]}
        >
          <Input type="email" maxLength={EMAIL_MAX} autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="roles"
          label={t('admin.users.form.roles')}
          extra={adminBlock ? t(`admin.users.blocked.${adminBlock}`) : undefined}
          rules={[
            { required: true, type: 'array', min: 1, message: t('admin.users.form.rolesRequired') },
          ]}
        >
          <Checkbox.Group
            options={ROLES.map((role) => ({
              value: role,
              label: t(`roles.${role}`),
              // The ADMIN role cannot be taken from oneself or from the last active admin.
              disabled: role === 'ADMIN' && adminBlock !== null,
            }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
