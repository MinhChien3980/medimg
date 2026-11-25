import { PictureOutlined } from '@ant-design/icons';
import { useState } from 'react';

interface PresignedThumbnailProps {
  /** Presigned GET URL; a refetch of its owner returns a fresh one. */
  url: string | null | undefined;
  alt: string;
  /** Base class; the placeholder also gets `${className}--empty`. */
  className: string;
  /** Called once per URL that fails, so the owner can refetch fresh URLs. */
  onError: () => void;
}

/**
 * Thumbnail behind a presigned URL. Presigned URLs expire after 15 minutes: a failed URL shows a
 * placeholder and asks the owner to refetch, once per URL, so an expired page heals itself while a
 * thumbnail that is really missing does not loop.
 */
export function PresignedThumbnail({ url, alt, className, onError }: PresignedThumbnailProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) {
    return (
      <div className={`${className} ${className}--empty`} role="img" aria-label={alt}>
        <PictureOutlined />
      </div>
    );
  }
  return (
    <img
      className={className}
      src={url}
      alt={alt}
      onError={() => {
        setFailedUrl(url);
        onError();
      }}
    />
  );
}
