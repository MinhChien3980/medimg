import { Alert, Form, InputNumber, Radio, Typography, type FormInstance } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  isSpacingInRange,
  SLICE_SPACING_MAX_MM,
  SLICE_SPACING_MIN_MM,
  SPACING_AXES,
  type SpacingValues,
  type ZipContent,
} from './fileValidation';

interface ZipContentFieldsProps {
  value: ZipContent;
  onChange: (value: ZipContent) => void;
  /** Owned by the wizard, which validates it before starting the upload. */
  form: FormInstance<SpacingValues>;
}

/**
 * What a ZIP holds and, for PNG/JPG slices, their voxel spacing. The three values are optional
 * together: left empty the server assumes 1 mm (said up front), partly filled is an error.
 */
export function ZipContentFields({ value, onChange, form }: ZipContentFieldsProps) {
  const { t } = useTranslation();
  const values = Form.useWatch([], form) as SpacingValues | undefined;
  const empty = SPACING_AXES.every((axis) => values?.[axis] == null);

  const validator = (_: unknown, v: number | null | undefined) => {
    if (v != null && !isSpacingInRange(v)) {
      return Promise.reject(
        new Error(
          t('upload.spacing.range', { min: SLICE_SPACING_MIN_MM, max: SLICE_SPACING_MAX_MM }),
        ),
      );
    }
    if (v == null && SPACING_AXES.some((axis) => form.getFieldValue(axis) != null)) {
      return Promise.reject(new Error(t('upload.spacing.incomplete')));
    }
    return Promise.resolve();
  };

  return (
    <div className="zip-content" data-testid="zip-content">
      <span id="zip-content-label" className="field-label">
        {t('upload.zip.label')}
      </span>
      <Radio.Group
        aria-labelledby="zip-content-label"
        orientation="vertical"
        value={value}
        onChange={(e) => onChange(e.target.value as ZipContent)}
        options={[
          { value: 'dicomSeries', label: t('upload.zip.dicomSeries') },
          { value: 'imageStack', label: t('upload.zip.imageStack') },
        ]}
      />

      <Form<SpacingValues> form={form} name="sliceSpacing" layout="vertical" requiredMark={false}>
        {value === 'imageStack' && (
          <Typography.Paragraph type="secondary" className="zip-content__hint">
            {t('upload.zip.imageStackHint')}
          </Typography.Paragraph>
        )}
        {value === 'imageStack' && (
          <fieldset className="spacing-fields">
            <legend className="spacing-fields__legend">{t('upload.spacing.legend')}</legend>
            <Typography.Paragraph type="secondary" className="spacing-fields__hint">
              {t('upload.spacing.hint', { min: SLICE_SPACING_MIN_MM, max: SLICE_SPACING_MAX_MM })}
            </Typography.Paragraph>
            <div className="spacing-fields__row">
              {SPACING_AXES.map((axis) => (
                <Form.Item
                  key={axis}
                  name={axis}
                  label={t(`upload.spacing.${axis}`)}
                  dependencies={SPACING_AXES.filter((other) => other !== axis)}
                  rules={[{ validator }]}
                >
                  <InputNumber<number> suffix="mm" step={0.1} style={{ width: '100%' }} />
                </Form.Item>
              ))}
            </div>
            {empty && <Alert type="warning" showIcon title={t('upload.spacing.assumedWarning')} />}
          </fieldset>
        )}
      </Form>
    </div>
  );
}
