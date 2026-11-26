import {
  EditOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Input, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { adminUsersApi } from '@/api/endpoints';
import { errorMessage } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import {
  ROLES,
  type AdminUserDto,
  type AdminUserQuery,
  type Role,
  type UserStatus,
} from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { formatDateTime } from '@/shared/lib/format';
import { TemporaryPasswordModal, type TemporaryPassword } from './TemporaryPasswordModal';
import { UserFormModal, type UserFormMode } from './UserFormModal';
import { lockBlock, resetBlock } from './userRules';

const DEFAULT_PAGE_SIZE = 20;
const STATUSES: readonly UserStatus[] = ['ACTIVE', 'LOCKED'];

type PendingAction = { kind: 'lock' | 'unlock' | 'reset'; user: AdminUserDto };

function positiveInt(value: string | null, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((v) => v === value);
}

/**
 * A row action, disabled with its reason when the server would refuse it. The reason is a
 * tooltip for the mouse and the button's accessible description for screen readers.
 */
function RowAction({
  id,
  icon,
  label,
  reason,
  danger,
  onClick,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  reason: string | null;
  danger?: boolean;
  onClick: () => void;
}) {
  const button = (
    <Button
      size="small"
      icon={icon}
      danger={danger}
      disabled={reason !== null}
      aria-describedby={reason ? id : undefined}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  if (!reason) return button;
  return (
    <Tooltip title={reason}>
      <span className="row-action--blocked">
        {button}
        <span id={id} className="sr-only">
          {reason}
        </span>
      </span>
    </Tooltip>
  );
}

/** `/admin/users` (ADMIN): list, create, edit, lock / unlock, reset password. */
export default function UsersPage() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const [params, setParams] = useSearchParams();
  const [formMode, setFormMode] = useState<UserFormMode | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [tempPassword, setTempPassword] = useState<TemporaryPassword | null>(null);

  // The address holds the filters, so reload and back / forward keep them.
  const q = params.get('q') ?? '';
  const role = oneOf(params.get('role'), ROLES);
  const status = oneOf(params.get('status'), STATUSES);
  const page = positiveInt(params.get('page'), 1);
  const size = positiveInt(params.get('size'), DEFAULT_PAGE_SIZE);
  const query: AdminUserQuery = { q, role, status, page: page - 1, size };

  const list = useQuery({
    queryKey: queryKeys.admin.users.list(query),
    queryFn: () => adminUsersApi.list(query),
    placeholderData: keepPreviousData,
  });
  // Only the count matters: whether locking / demoting an admin would leave none active.
  const activeAdminsQuery = useQuery({
    queryKey: queryKeys.admin.users.activeAdmins,
    queryFn: () => adminUsersApi.list({ role: 'ADMIN', status: 'ACTIVE', page: 0, size: 1 }),
  });
  const activeAdmins = activeAdminsQuery.data?.totalElements ?? null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.all });

  const update = (next: Record<string, string | number | undefined>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === '') merged.delete(k);
      else merged.set(k, String(v));
    }
    setParams(merged);
  };

  const action = useMutation({
    // A reset returns a temporary password: keep it out of the mutation cache.
    gcTime: 0,
    mutationFn: async ({ kind, user }: PendingAction) => {
      if (kind === 'lock') return { kind, user: await adminUsersApi.lock(user.id) };
      if (kind === 'unlock') return { kind, user: await adminUsersApi.unlock(user.id) };
      const { temporaryPassword } = await adminUsersApi.resetPassword(user.id);
      return { kind, user, temporaryPassword };
    },
    onSuccess: (outcome) => {
      setPending(null);
      if (outcome.kind === 'reset' && 'temporaryPassword' in outcome) {
        setTempPassword({
          username: outcome.user.username,
          password: outcome.temporaryPassword,
          kind: 'reset',
        });
      } else {
        void message.success(
          t(`admin.users.done.${outcome.kind === 'lock' ? 'locked' : 'unlocked'}`, {
            username: outcome.user.username,
          }),
        );
      }
      // Drop the result (it may hold a temporary password) from the mutation cache.
      action.reset();
      void refresh();
    },
    onError: (error) => {
      // E.g. 409: another admin locked the second-to-last admin meanwhile. The list is read again.
      setPending(null);
      void message.error(errorMessage(error, t('common.unexpectedError')));
      void refresh();
    },
  });

  const reload = async (id: string) => {
    await refresh();
    const fresh = queryClient.getQueryData<{ content: AdminUserDto[] }>(
      queryKeys.admin.users.list(query),
    );
    return fresh?.content.find((u) => u.id === id) ?? null;
  };

  const columns: ColumnsType<AdminUserDto> = [
    {
      title: t('admin.users.columns.username'),
      dataIndex: 'username',
      render: (username: string, user) => (
        <Space size={4}>
          <Typography.Text strong>{username}</Typography.Text>
          {user.id === me?.id && <Tag>{t('admin.users.you')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('admin.users.columns.fullName'),
      dataIndex: 'fullName',
      render: (fullName: string, user) => (
        <div>
          <div>{fullName}</div>
          {user.email && <Typography.Text type="secondary">{user.email}</Typography.Text>}
        </div>
      ),
    },
    {
      title: t('admin.users.columns.roles'),
      dataIndex: 'roles',
      render: (roles: Role[]) => (
        <Space size={[4, 4]} wrap>
          {roles.map((r) => (
            <Tag key={r} color={r === 'ADMIN' ? 'gold' : 'geekblue'}>
              {t(`roles.${r}`)}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('admin.users.columns.status'),
      dataIndex: 'status',
      render: (s: UserStatus, user) => (
        <Space size={[4, 4]} wrap>
          <Tag
            color={s === 'LOCKED' ? 'red' : 'green'}
            icon={s === 'LOCKED' ? <LockOutlined /> : undefined}
          >
            {t(`admin.users.statuses.${s}`)}
          </Tag>
          {user.passwordChangeRequired && <Tag color="orange">{t('admin.users.mustChange')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('admin.users.columns.lastLogin'),
      dataIndex: 'lastLoginAt',
      render: (v: string | null) => (v ? formatDateTime(v, i18n.language) : t('admin.users.never')),
    },
    {
      title: t('admin.users.columns.createdAt'),
      dataIndex: 'createdAt',
      render: (v: string) => formatDateTime(v, i18n.language),
    },
    {
      title: t('admin.users.columns.actions'),
      key: 'actions',
      render: (_: unknown, user) => {
        const lockReason = lockBlock(user, me, activeAdmins);
        const resetReason = resetBlock(user, me);
        return (
          <Space size={4} wrap>
            <RowAction
              id={`edit-${user.id}`}
              icon={<EditOutlined aria-hidden />}
              label={t('admin.users.actions.edit')}
              reason={null}
              onClick={() => setFormMode({ kind: 'edit', user })}
            />
            {user.status === 'ACTIVE' ? (
              <RowAction
                id={`lock-reason-${user.id}`}
                icon={<LockOutlined aria-hidden />}
                label={t('admin.users.actions.lock')}
                danger
                reason={lockReason ? t(`admin.users.blocked.${lockReason}`) : null}
                onClick={() => setPending({ kind: 'lock', user })}
              />
            ) : (
              <RowAction
                id={`unlock-${user.id}`}
                icon={<UnlockOutlined aria-hidden />}
                label={t('admin.users.actions.unlock')}
                reason={null}
                onClick={() => setPending({ kind: 'unlock', user })}
              />
            )}
            <RowAction
              id={`reset-reason-${user.id}`}
              icon={<KeyOutlined aria-hidden />}
              label={t('admin.users.actions.reset')}
              reason={resetReason ? t(`admin.users.blocked.${resetReason}`) : null}
              onClick={() => setPending({ kind: 'reset', user })}
            />
          </Space>
        );
      },
    },
  ];

  const confirmText =
    pending &&
    {
      lock: {
        title: t('admin.users.confirm.lockTitle', { username: pending.user.username }),
        body: t('admin.users.confirm.lockBody'),
        ok: t('admin.users.actions.lock'),
      },
      unlock: {
        title: t('admin.users.confirm.unlockTitle', { username: pending.user.username }),
        body: t('admin.users.confirm.unlockBody'),
        ok: t('admin.users.actions.unlock'),
      },
      reset: {
        title: t('admin.users.confirm.resetTitle', { username: pending.user.username }),
        body: t('admin.users.confirm.resetBody'),
        ok: t('admin.users.actions.reset'),
      },
    }[pending.kind];

  return (
    <div className="page">
      <div className="page__header">
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('admin.users.title')}
        </Typography.Title>
        <Button
          type="primary"
          icon={<PlusOutlined aria-hidden />}
          onClick={() => setFormMode({ kind: 'create' })}
        >
          {t('admin.users.newUser')}
        </Button>
      </div>

      <div className="admin-filters" role="search">
        <Input.Search
          allowClear
          defaultValue={q}
          placeholder={t('admin.users.search')}
          aria-label={t('admin.users.search')}
          onSearch={(value) => update({ q: value.trim(), page: undefined })}
          style={{ width: 320 }}
        />
        <Select<Role>
          allowClear
          value={role}
          placeholder={t('admin.users.allRoles')}
          aria-label={t('admin.users.role')}
          style={{ width: 180 }}
          options={ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
          onChange={(value) => update({ role: value, page: undefined })}
        />
        <Select<UserStatus>
          allowClear
          value={status}
          placeholder={t('admin.users.allStatuses')}
          aria-label={t('admin.users.status')}
          style={{ width: 180 }}
          options={STATUSES.map((s) => ({ value: s, label: t(`admin.users.statuses.${s}`) }))}
          onChange={(value) => update({ status: value, page: undefined })}
        />
      </div>

      {list.isError && (
        <ProblemAlert
          error={list.error}
          onRetry={() => void list.refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      <Table<AdminUserDto>
        rowKey="id"
        columns={columns}
        dataSource={list.data?.content ?? []}
        loading={list.isFetching}
        scroll={{ x: 960 }}
        locale={{ emptyText: t('admin.users.empty') }}
        pagination={{
          current: page,
          pageSize: size,
          total: list.data?.totalElements ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          showTotal: (total) => t('admin.users.total', { count: total }),
          onChange: (nextPage, nextSize) =>
            update({
              page: nextSize !== size || nextPage === 1 ? undefined : nextPage,
              size: nextSize === DEFAULT_PAGE_SIZE ? undefined : nextSize,
            }),
        }}
      />

      {formMode && (
        <UserFormModal
          key={formMode.kind === 'edit' ? formMode.user.id : 'create'}
          mode={formMode}
          me={me}
          activeAdmins={activeAdmins}
          onClose={() => setFormMode(null)}
          reload={reload}
          onCreated={({ user, temporaryPassword }) => {
            setFormMode(null);
            void message.success(t('admin.users.done.created', { username: user.username }));
            setTempPassword({
              username: user.username,
              password: temporaryPassword,
              kind: 'created',
            });
            void refresh();
          }}
          onSaved={(user) => {
            setFormMode(null);
            void message.success(t('admin.users.done.updated', { username: user.username }));
            void refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={pending !== null}
        title={confirmText?.title ?? ''}
        okText={confirmText?.ok ?? ''}
        danger={pending?.kind !== 'unlock'}
        loading={action.isPending}
        onOk={() => pending && action.mutate(pending)}
        onCancel={() => setPending(null)}
      >
        {confirmText?.body}
      </ConfirmDialog>

      <TemporaryPasswordModal value={tempPassword} onClose={() => setTempPassword(null)} />
    </div>
  );
}
