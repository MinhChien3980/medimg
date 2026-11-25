import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined } from '@ant-design/icons';
import { App, Button, Empty, Input, Popconfirm, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { errorMessage } from '@/api/problem';
import {
  KEY_IMAGE_CAPTION_MAX,
  KEY_IMAGE_MAX_COUNT,
  type KeyImageOrderItem,
  type ReportDto,
  type ReportKeyImageDto,
} from '@/api/types';
import { useRemoveKeyImage } from './hooks';
import { keyImageItems, moveKeyImage, orderedKeyImages as ordered } from './reportModel';

function KeyImagePicture({ image, index }: { image: ReportKeyImageDto; index: number }) {
  const { t } = useTranslation();
  if (!image.uploaded || !image.url) {
    return (
      <div className="key-image__img key-image__img--missing">
        <Tag color="warning">{t('reports.keyImages.notUploaded')}</Tag>
      </div>
    );
  }
  return (
    <img
      className="key-image__img"
      src={image.url}
      alt={image.caption || t('reports.keyImages.alt', { n: index + 1 })}
    />
  );
}

/** Key images of a signed (or read-only) report: picture and caption, in order. */
export function KeyImagesView({ report }: { report: ReportDto }) {
  const { t } = useTranslation();
  const images = ordered(report);
  if (images.length === 0) {
    return <Typography.Text type="secondary">{t('reports.keyImages.none')}</Typography.Text>;
  }
  return (
    <ol className="key-images key-images--read">
      {images.map((k, i) => (
        <li key={k.id} className="key-image">
          <KeyImagePicture image={k} index={i} />
          <span className="key-image__caption">
            {i + 1}. {k.caption}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Key images of a draft: caption (saved on blur / Enter), order (up / down buttons, keyboard
 * operable), removal. Images are added from the viewers ("Add to report"). Order and captions are
 * saved with the draft's sections (`onChange` gets every image once, in order).
 */
export function KeyImagesEditor({
  report,
  onChange,
}: {
  report: ReportDto;
  onChange: (items: KeyImageOrderItem[]) => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const remove = useRemoveKeyImage();
  const images = ordered(report);
  const ids = images.map((k) => k.id);
  const onError = (e: unknown) => void message.error(errorMessage(e));

  return (
    <div className="key-images-editor">
      <div className="key-images-editor__head">
        <Tag>{t('reports.keyImages.count', { n: images.length, max: KEY_IMAGE_MAX_COUNT })}</Tag>
        <Typography.Text type="secondary">
          {t('reports.keyImages.hint')}{' '}
          <Link to={`/studies/${report.studyId}`}>{t('reports.openViewer')}</Link>
        </Typography.Text>
      </div>
      {images.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('reports.keyImages.none')} />
      ) : (
        <ol className="key-images" aria-label={t('reports.keyImages.title')}>
          {images.map((k, i) => (
            <li key={k.id} className="key-image" data-testid={`key-image-${i}`}>
              <KeyImagePicture image={k} index={i} />
              <CaptionInput
                key={`${k.id}:${k.caption ?? ''}`}
                initial={k.caption ?? ''}
                label={t('reports.keyImages.captionOf', { n: i + 1 })}
                onSave={(text) => onChange(keyImageItems(ids, { id: k.id, caption: text }))}
              />
              <span className="key-image__actions">
                <Tooltip title={t('reports.keyImages.up')}>
                  <Button
                    size="small"
                    icon={<ArrowUpOutlined />}
                    disabled={i === 0}
                    aria-label={t('reports.keyImages.upNamed', { n: i + 1 })}
                    onClick={() => onChange(keyImageItems(moveKeyImage(ids, i, -1)))}
                  />
                </Tooltip>
                <Tooltip title={t('reports.keyImages.down')}>
                  <Button
                    size="small"
                    icon={<ArrowDownOutlined />}
                    disabled={i === images.length - 1}
                    aria-label={t('reports.keyImages.downNamed', { n: i + 1 })}
                    onClick={() => onChange(keyImageItems(moveKeyImage(ids, i, 1)))}
                  />
                </Tooltip>
                <Popconfirm
                  title={t('reports.keyImages.deleteConfirm')}
                  okText={t('reports.keyImages.delete')}
                  cancelText={t('common.cancel')}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove.mutate({ report, imageId: k.id }, { onError })}
                >
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={t('reports.keyImages.deleteNamed', { n: i + 1 })}
                  />
                </Popconfirm>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CaptionInput({
  initial,
  label,
  onSave,
}: {
  initial: string;
  label: string;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const commit = () => {
    const next = text.trim();
    if (next !== initial) onSave(next);
  };
  return (
    <Input
      size="small"
      className="key-image__caption-input"
      value={text}
      maxLength={KEY_IMAGE_CAPTION_MAX}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onPressEnter={commit}
    />
  );
}
