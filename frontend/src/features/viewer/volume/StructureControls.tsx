import { AimOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Empty, Slider, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FindingDto, Uuid } from '@/api/types';
import { useStructureName } from '@/features/ai/structureNames';
import {
  FindingReviewActions,
  ReviewDetails,
  ReviewStatusTag,
  UnreviewedFilter,
} from '@/features/review/FindingReview';
import { isUnreviewed } from '@/features/review/reviewModel';
import { formatVolumeMl } from '@/shared/lib/format';
import type { Structure, StructureStyle } from './structures';

export interface StructureControlsProps {
  studyId: Uuid;
  /** Findings of the run (one per structure label), for the review of each structure. */
  findings: readonly FindingDto[];
  structures: readonly Structure[];
  styles: Readonly<Record<string, StructureStyle>>;
  onChange: (label: string, patch: Partial<StructureStyle>) => void;
  onChangeAll: (patch: Partial<StructureStyle>) => void;
  /** Moves the MPR crosshair to the structure's centroid. */
  onLocate: (label: string) => void;
}

/**
 * Segmented structures with their volume, and the display settings shared by MPR and 3D:
 * visibility, colour, opacity, plus the doctor's review of each structure. Every control is a
 * labelled native or antd control (keyboard operable); the eye toggles expose their state with
 * `aria-pressed`.
 */
export function StructureControls({
  studyId,
  findings,
  structures,
  styles,
  onChange,
  onChangeAll,
  onLocate,
}: StructureControlsProps) {
  const { t, i18n } = useTranslation();
  const name = useStructureName();
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const findingOf = new Map(findings.map((f) => [f.label, f]));

  if (structures.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ai.noStructures')} />;
  }

  return (
    <div className="structures" data-testid="structure-controls">
      <Space size={4} className="structures__bulk">
        <Button size="small" onClick={() => onChangeAll({ visible: true })}>
          {t('viewer.structures.showAll')}
        </Button>
        <Button size="small" onClick={() => onChangeAll({ visible: false })}>
          {t('viewer.structures.hideAll')}
        </Button>
      </Space>
      <UnreviewedFilter findings={findings} checked={unreviewedOnly} onChange={setUnreviewedOnly} />
      <ul className="structures__list" aria-label={t('viewer.structures.list')}>
        {structures.map((s) => {
          const style = styles[s.label];
          const finding = findingOf.get(s.label);
          if (!style) return null;
          if (unreviewedOnly && (!finding || !isUnreviewed(finding))) return null;
          const display = name(s.label);
          return (
            <li key={s.label} className="structure-row" data-testid={`structure-${s.label}`}>
              <div className="structure-row__main">
                <Tooltip
                  title={t(style.visible ? 'viewer.structures.hide' : 'viewer.structures.show')}
                >
                  <Button
                    type="text"
                    size="small"
                    aria-pressed={style.visible}
                    aria-label={t('viewer.structures.toggle', { name: display })}
                    icon={style.visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                    onClick={() => onChange(s.label, { visible: !style.visible })}
                  />
                </Tooltip>
                <input
                  type="color"
                  className="structure-row__color"
                  value={style.color}
                  aria-label={t('viewer.structures.color', { name: display })}
                  onChange={(e) => onChange(s.label, { color: e.target.value })}
                />
                <span className="structure-row__name">
                  {display}
                  {s.value === null && (
                    <Tooltip title={t('viewer.structures.notInMpr')}>
                      <Typography.Text type="warning" className="structure-row__flag">
                        3D
                      </Typography.Text>
                    </Tooltip>
                  )}
                </span>
                <span className="structure-row__volume">
                  {formatVolumeMl(s.volumeMl, i18n.language)}
                </span>
                <Tooltip title={t('viewer.structures.locateHint')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<AimOutlined />}
                    aria-label={t('viewer.structures.locate', { name: display })}
                    onClick={() => onLocate(s.label)}
                  />
                </Tooltip>
              </div>
              <div className="structure-row__opacity">
                <span aria-hidden>{t('viewer.structures.opacity')}</span>
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={style.opacity}
                  disabled={!style.visible}
                  onChange={(v) => onChange(s.label, { opacity: v })}
                  ariaLabelForHandle={t('viewer.structures.opacityOf', { name: display })}
                  tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
                />
              </div>
              {finding && (
                <div className="structure-row__review">
                  <ReviewStatusTag finding={finding} />
                  <FindingReviewActions studyId={studyId} finding={finding} name={display} />
                  <ReviewDetails finding={finding} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
