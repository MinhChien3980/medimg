import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Form, Input, InputNumber, Modal, Segmented } from 'antd';
import { useTranslation } from 'react-i18next';
import { patientsApi } from '@/api/endpoints';
import { toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type { CreatePatientRequest, PatientDto, Sex } from '@/api/types';
import { ProblemAlert } from '@/shared/components/ProblemAlert';

interface NewCaseFormValues {
  code?: string;
  birthYear?: number | null;
  sex?: Sex;
  note?: string;
}

interface NewCaseModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (patient: PatientDto) => void;
}

const SEXES: Sex[] = ['M', 'F', 'O'];

/** Limits enforced by core-service (`POST /patients`). */
export const CASE_CODE_MAX = 32;
export const NOTE_MAX = 500;
export const MIN_BIRTH_YEAR = 1900;
const CASE_CODE_PATTERN = /^[A-Za-z0-9_-]*$/;

const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);

function toRequest(v: NewCaseFormValues): CreatePatientRequest {
  const body: CreatePatientRequest = {};
  const code = v.code?.trim();
  if (code) body.code = code;
  if (typeof v.birthYear === 'number') body.birthYear = v.birthYear;
  if (v.sex) body.sex = v.sex;
  const note = v.note?.trim();
  if (note) body.note = note;
  return body;
}

export function NewCaseModal({ open, onClose, onCreated }: NewCaseModalProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<NewCaseFormValues>();
  const queryClient = useQueryClient();
  const currentYear = new Date().getFullYear();

  const create = useMutation({
    mutationFn: (values: NewCaseFormValues) => patientsApi.create(toRequest(values)),
    onSuccess: (patient) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.patients.all });
      form.resetFields();
      onCreated(patient);
    },
    onError: (error) => {
      // Map server-side field validation errors onto the form fields.
      const known = new Set(['code', 'birthYear', 'sex', 'note']);
      const fields = toAppError(error)
        .fieldErrors.filter((f) => f.field && known.has(f.field))
        .map((f) => ({ name: f.field as keyof NewCaseFormValues, errors: [f.message] }));
      if (fields.length > 0) form.setFields(fields);
    },
  });

  return (
    <Modal
      open={open}
      title={t('cases.newCase')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={create.isPending}
      onOk={() => form.submit()}
      onCancel={() => {
        create.reset();
        onClose();
      }}
      destroyOnHidden
    >
      {create.isError && <ProblemAlert error={create.error} style={{ marginBottom: 16 }} />}
      <Form<NewCaseFormValues>
        form={form}
        layout="vertical"
        onFinish={(values) => create.mutate(values)}
        initialValues={{ sex: undefined }}
      >
        <Form.Item
          name="code"
          label={t('cases.form.code')}
          extra={t('cases.form.codeHint')}
          rules={[
            { pattern: CASE_CODE_PATTERN, transform: trim, message: t('cases.form.codeInvalid') },
            {
              max: CASE_CODE_MAX,
              transform: trim,
              message: t('cases.form.tooLong', { max: CASE_CODE_MAX }),
            },
          ]}
        >
          <Input maxLength={CASE_CODE_MAX} placeholder="CASE-…" />
        </Form.Item>
        <Form.Item
          name="birthYear"
          label={t('cases.form.birthYear')}
          rules={[
            {
              type: 'number',
              min: MIN_BIRTH_YEAR,
              max: currentYear,
              message: t('cases.form.birthYearInvalid', { min: MIN_BIRTH_YEAR, max: currentYear }),
            },
          ]}
        >
          <InputNumber
            min={MIN_BIRTH_YEAR}
            max={currentYear}
            precision={0}
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item name="sex" label={t('cases.form.sex')}>
          <Segmented<Sex> options={SEXES.map((s) => ({ value: s, label: t(`cases.sex.${s}`) }))} />
        </Form.Item>
        <Form.Item
          name="note"
          label={t('cases.form.note')}
          rules={[
            { max: NOTE_MAX, transform: trim, message: t('cases.form.tooLong', { max: NOTE_MAX }) },
          ]}
        >
          <Input.TextArea
            rows={3}
            maxLength={NOTE_MAX}
            showCount
            placeholder={t('cases.form.notePlaceholder')}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
