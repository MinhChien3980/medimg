import { Button, Result } from 'antd';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '@/i18n';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this value resets the boundary (e.g. pass the current pathname). */
  resetKey?: unknown;
  /** Rendered instead of the generic fallback. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: unknown;
}

/** Catches render errors below it and shows a recoverable fallback. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private readonly reset = () => this.setState({ error: null });

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <ErrorFallback
        message={this.state.error.message}
        onReset={this.reset}
        onReload={() => window.location.reload()}
      />
    );
  }
}

interface ErrorFallbackProps {
  message?: string;
  onReset?: () => void;
  onReload?: () => void;
}

export function ErrorFallback({ message, onReset, onReload }: ErrorFallbackProps) {
  return (
    <Result
      status="error"
      title={i18n.t('errors.boundaryTitle')}
      subTitle={
        <>
          <div>{i18n.t('errors.boundaryBody')}</div>
          {message && (
            <code style={{ display: 'block', marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              {message}
            </code>
          )}
        </>
      }
      extra={[
        onReset && (
          <Button key="retry" type="primary" onClick={onReset}>
            {i18n.t('common.retry')}
          </Button>
        ),
        onReload && (
          <Button key="reload" onClick={onReload}>
            {i18n.t('common.reload')}
          </Button>
        ),
      ]}
    />
  );
}
