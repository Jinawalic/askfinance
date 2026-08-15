'use client';

import React, { useEffect, useState } from 'react';

export type ToastType = 'success' | 'error' | 'info';

interface ToastProps {
  message: string;
  type: ToastType;
  onClose: () => void;
  duration?: number;
}

export const Toast: React.FC<ToastProps> = ({ message, type, onClose, duration = 4000 }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    const showTimer = setTimeout(() => setVisible(true), 10);
    // Auto-dismiss
    const hideTimer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300);
    }, duration);

    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, [duration, onClose]);

  const styles: Record<ToastType, { bg: string; border: string; icon: string }> = {
    success: { bg: '#f0fdf4', border: '#22c55e', icon: '✅' },
    error:   { bg: '#fef2f2', border: '#ef4444', icon: '❌' },
    info:    { bg: '#eff6ff', border: '#3b82f6', icon: 'ℹ️' },
  };

  const s = styles[type];

  return (
    <div
      style={{
        position: 'fixed',
        top: '1.25rem',
        right: '1.25rem',
        zIndex: 9999,
        maxWidth: '22rem',
        width: 'calc(100vw - 2.5rem)',
        background: s.bg,
        border: `1.5px solid ${s.border}`,
        borderRadius: '0.875rem',
        padding: '0.875rem 1rem',
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.625rem',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-12px)',
        pointerEvents: 'auto',
      }}
      role="alert"
    >
      <span style={{ fontSize: '1.1rem', lineHeight: 1.4 }}>{s.icon}</span>
      <p style={{ margin: 0, fontSize: '0.875rem', color: '#1f2937', lineHeight: 1.5, flex: 1 }}>
        {message}
      </p>
      <button
        onClick={() => { setVisible(false); setTimeout(onClose, 300); }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '1rem',
          lineHeight: 1,
          color: '#6b7280',
          padding: '0 0.125rem',
          flexShrink: 0,
        }}
        aria-label="Close notification"
      >
        ×
      </button>
    </div>
  );
};

// ── Simple hook for imperative toast usage ──────────────────────────────────

interface ToastState {
  message: string;
  type: ToastType;
  id: number;
}

export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);

  const show = (message: string, type: ToastType = 'info') => {
    setToast({ message, type, id: Date.now() });
  };

  const hide = () => setToast(null);

  const ToastRenderer = toast ? (
    <Toast key={toast.id} message={toast.message} type={toast.type} onClose={hide} />
  ) : null;

  return { show, ToastRenderer };
}
