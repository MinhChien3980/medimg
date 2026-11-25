import { DeleteOutlined, EditOutlined, StarOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { patientsApi } from '@/api/endpoints';
import { errorMessage, toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type { MarkSampleRequest, PatientDto, SampleInfo } from '@/api/types';
import { useCan } from '@/features/auth/permissions';
import { ProblemAlert } from '@/shared/components/ProblemAlert';

/** Limits enforced by core-service (`PUT /patients/{id}/sample`, columns of V6). */
export const SAMPLE_TITLE_MAX = 120;
export const SAMPLE_DESCRIPTION_MAX = 500;
export const SAMPLE_SOURCE_MAX = 300;

interface SampleFormValues {
  title: string;
  description?: string;
  source: string;
}

const FIELDS = new Set<keyof SampleFormValues>(['title', 'description', 'source']);

const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);

function toRequest(v: SampleFormValues): MarkSampleRequest {
  const description = v.description?.trim();
  return {
    title: v.title.trim(),
    ...(description ? { description } : {}),
    source: v.source.trim(),
  };
}

/**
 * "Sample case" section of the case page. Everyone sees how a sample case is presented; admins
 * (`manageSamples`) mark the case as a sample, edit that presentation or remove it. Hidden for a
 * non-admin when the case is not a sample.
 */
export function CaseSampleCard({ patient }: { patient: PatientDto }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const can = useCan();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const admin = can('manageSamples');
  const sample = patient.sample;

  const unmark = useMutation({
    mutationFn: () => patientsApi.unmarkSample(patient.id),
    onSuccess: () => {
      queryClient.setQueryData<PatientDto>(queryKeys.patients.detail(patient.id), (prev) =>
        prev ? { ...prev, sample: null } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.samples.all });
      void message.success(t('samples.admin.unmarked'));
    },
    onError: (e) => void message.error(errorMessage(e)),
  });

  if (!sample && !admin) return null;

  return (
    <Card
      title={
        <span>
          <StarOutlined /> {t('samples.admin.section')}
        </span>
      }
      size="small"
      style={{ marginBottom: 16 }}
      extra={
        admin && (
          <Space wrap>
            <Button
              size="small"
              type={sample ? 'default' : 'primary'}
              icon={sample ? <EditOutlined /> : <StarOutlined />}
              onClick={() => setEditing(true)}
            >
              {t(sample ? 'samples.admin.edit' : 'samples.admin.mark')}
            </Button>
            {sample && (
              <Popconfirm
                title={t('samples.admin.unmarkConfirm')}
                okText={t('samples.admin.remove')}
                cancelText={t('common.cancel')}
                okButtonProps={{ danger: true }}
                onConfirm={() => unmark.mutate()}
              >
                <Button size="small" danger icon={<DeleteOutlined />} loading={unmark.isPending}>
                  {t('samples.admin.unmark')}
                </Button>
              </Popconfirm>
            )}
          </Space>
        )
      }
    >
      {sample ? (
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: 'title', label: t('samples.admin.title'), children: sample.title },
            {
              key: 'description',
              label: t('samples.admin.description'),
              children: sample.description || t('common.none'),
            },
            { key: 'source', label: t('samples.admin.source'), children: sample.source },
          ]}
        />
      ) : (
        <Typography.Text type="secondary">{t('samples.admin.notSample')}</Typography.Text>
      )}
      {editing && (
        <SampleFormModal patientId={patient.id} sample={sample} onClose={() => setEditing(false)} />
      )}
    </Card>
  );
}

interface SampleFormModalProps {
  patientId: string;
  sample: SampleInfo | null;
  onClose: () => void;
}

/** Mounted only while open, so the form always starts from the case's current values. */
function SampleFormModal({ patientId, sample, onClose }: SampleFormModalProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<SampleFormValues>();
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: (values: SampleFormValues) => patientsApi.markSample(patientId, toRequest(values)),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.patients.detail(patientId), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.samples.all });
      void message.success(t('samples.admin.marked'));
      onClose();
    },
    onError: (error) => {
      const fields = toAppError(error)
        .fieldErrors.filter((f) => f.field && FIELDS.has(f.field as keyof SampleFormValues))
        .map((f) => ({ name: f.field as keyof SampleFormValues, errors: [f.message] }));
      if (fields.length > 0) form.setFields(fields);
    },
  });

  const tooLong = (max: number) => ({
    max,
    transform: trim,
    message: t('samples.admin.tooLong', { max }),
  });
  const required = { required: true, whitespace: true, message: t('samples.admin.required') };

  return (
    <Modal
      open
      title={t(sample ? 'samples.admin.edit' : 'samples.admin.mark')}
      okText={t('samples.admin.save')}
      cancelText={t('common.cancel')}
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      {save.isError && <ProblemAlert error={save.error} style={{ marginBottom: 16 }} />}
      <Form<SampleFormValues>
        form={form}
        name="sample"
        layout="vertical"
        initialValues={{
          title: sample?.title ?? '',
          description: sample?.description ?? '',
          source: sample?.source ?? '',
        }}
        onFinish={(values) => save.mutate(values)}
      >
        <Form.Item
          name="title"
          label={t('samples.admin.title')}
          rules={[required, tooLong(SAMPLE_TITLE_MAX)]}
        >
          <Input maxLength={SAMPLE_TITLE_MAX} showCount />
        </Form.Item>
        <Form.Item
          name="description"
          label={t('samples.admin.description')}
          rules={[tooLong(SAMPLE_DESCRIPTION_MAX)]}
        >
          <Input.TextArea rows={3} maxLength={SAMPLE_DESCRIPTION_MAX} showCount />
        </Form.Item>
        <Form.Item
          name="source"
          label={t('samples.admin.source')}
          rules={[required, tooLong(SAMPLE_SOURCE_MAX)]}
        >
          <Input.TextArea
            rows={2}
            maxLength={SAMPLE_SOURCE_MAX}
            showCount
            placeholder={t('samples.admin.sourcePlaceholder')}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
