import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { patientsApi } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import type { PatientDto } from '@/api/types';
import { NewCaseModal } from '@/features/cases/NewCaseModal';
import { ProblemAlert } from '@/shared/components/ProblemAlert';

interface CasePickerProps {
  value: PatientDto | null;
  onChange: (patient: PatientDto | null) => void;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Remote-searchable case select plus "create new case". */
export function CasePicker({ value, onChange }: CasePickerProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim(), 300);
  const query = { q, page: 0, size: 20 };

  const list = useQuery({
    queryKey: queryKeys.patients.list(query),
    queryFn: () => patientsApi.list(query),
  });

  const options = [...(list.data?.content ?? [])];
  if (value && !options.some((p) => p.id === value.id)) options.unshift(value);

  return (
    <div>
      <Typography.Paragraph>{t('upload.pickCase')}</Typography.Paragraph>
      {list.isError && <ProblemAlert error={list.error} style={{ marginBottom: 12 }} />}
      <Space wrap>
        <Select<string>
          aria-label={t('upload.searchCase')}
          style={{ width: 320 }}
          placeholder={t('upload.searchCase')}
          value={value?.id}
          loading={list.isFetching}
          virtual={false}
          allowClear
          showSearch={{ filterOption: false, onSearch: setSearch }}
          onChange={(id) => onChange(options.find((p) => p.id === id) ?? null)}
          options={options.map((p) => ({
            value: p.id,
            label: p.note ? `${p.code} · ${p.note}` : p.code,
          }))}
        />
        <Typography.Text type="secondary">{t('upload.orCreate')}</Typography.Text>
        <Button icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          {t('upload.createCase')}
        </Button>
      </Space>
      <NewCaseModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(patient) => {
          setCreating(false);
          onChange(patient);
        }}
      />
    </div>
  );
}
