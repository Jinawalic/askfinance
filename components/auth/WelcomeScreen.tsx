'use client';

import React, { useState } from 'react';

interface WelcomeScreenProps {
  onNext: (name: string) => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onNext }) => {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const sanitized = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (sanitized.length < 3) {
      setError('Username must be at least 3 characters (letters, numbers, underscores only).');
      return;
    }
    setLoading(true);
    try {
      await onNext(sanitized);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f0c29 0%, #1a1a4e 40%, #0d2137 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
      fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
    }}>

      {/* Ambient glow blobs */}
      <div style={{
        position: 'fixed', top: '10%', left: '15%', width: '400px', height: '400px',
        background: 'radial-gradient(circle, rgba(99,162,207,0.15) 0%, transparent 70%)',
        borderRadius: '50%', pointerEvents: 'none',
      }} />
      <div style={{
        position: 'fixed', bottom: '15%', right: '10%', width: '350px', height: '350px',
        background: 'radial-gradient(circle, rgba(123,97,255,0.12) 0%, transparent 70%)',
        borderRadius: '50%', pointerEvents: 'none',
      }} />

      {/* Card */}
      <div style={{
        width: '100%',
        maxWidth: '420px',
        background: 'rgba(255,255,255,0.04)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '24px',
        padding: '2.5rem 2rem',
        textAlign: 'center',
        boxShadow: '0 32px 80px rgba(0,0,0,0.4), 0 0 0 1px rgba(99,162,207,0.1)',
        position: 'relative',
        zIndex: 1,
      }}>

        {/* Logo */}
        <div style={{
          width: '80px', height: '80px',
          background: 'linear-gradient(135deg, #63a2cf 0%, #7b61ff 100%)',
          borderRadius: '24px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '2rem',
          margin: '0 auto 1.5rem',
          boxShadow: '0 8px 32px rgba(99,162,207,0.4)',
        }}>
          🤖
        </div>

        {/* Heading */}
        <h1 style={{
          fontSize: '1.875rem',
          fontWeight: 700,
          color: '#ffffff',
          margin: '0 0 0.5rem',
          letterSpacing: '-0.02em',
          lineHeight: 1.2,
        }}>
          Finance AI
        </h1>
        <p style={{
          fontSize: '0.9375rem',
          color: 'rgba(255,255,255,0.5)',
          margin: '0 0 2rem',
          lineHeight: 1.6,
        }}>
          Choose a username to get started. You&apos;ll be redirected to our{' '}
          <span style={{ color: '#63a2cf', fontWeight: 500 }}>Telegram bot</span> to begin chatting.
        </p>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <div style={{ position: 'relative' }}>
            <input
              id="username-input"
              type="text"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError(''); }}
              required
              autoComplete="off"
              autoFocus
              maxLength={32}
              style={{
                width: '100%',
                padding: '0.9375rem 1.125rem',
                background: 'rgba(255,255,255,0.07)',
                border: error ? '1.5px solid rgba(239,68,68,0.7)' : '1.5px solid rgba(255,255,255,0.12)',
                borderRadius: '14px',
                color: '#ffffff',
                fontSize: '0.9375rem',
                outline: 'none',
                transition: 'border-color 0.2s, box-shadow 0.2s',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => {
                if (!error) e.target.style.borderColor = 'rgba(99,162,207,0.6)';
                e.target.style.boxShadow = '0 0 0 3px rgba(99,162,207,0.12)';
              }}
              onBlur={(e) => {
                if (!error) e.target.style.borderColor = 'rgba(255,255,255,0.12)';
                e.target.style.boxShadow = 'none';
              }}
            />
          </div>

          {error && (
            <p style={{
              fontSize: '0.8125rem',
              color: '#f87171',
              textAlign: 'left',
              margin: '-0.25rem 0 0',
              padding: '0 0.25rem',
            }}>
              {error}
            </p>
          )}

          <button
            id="continue-btn"
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '0.9375rem 1.5rem',
              background: loading
                ? 'rgba(99,162,207,0.4)'
                : 'linear-gradient(135deg, #63a2cf 0%, #7b61ff 100%)',
              border: 'none',
              borderRadius: '14px',
              color: '#ffffff',
              fontSize: '0.9375rem',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'opacity 0.2s, transform 0.15s, box-shadow 0.2s',
              boxShadow: loading ? 'none' : '0 4px 20px rgba(99,162,207,0.35)',
              letterSpacing: '0.01em',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                (e.currentTarget as HTMLButtonElement).style.opacity = '0.9';
                (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 8px 28px rgba(99,162,207,0.45)';
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = '1';
              (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
              (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 20px rgba(99,162,207,0.35)';
            }}
          >
            {loading ? (
              <>
                <span style={{
                  width: '16px', height: '16px',
                  border: '2px solid rgba(255,255,255,0.4)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  display: 'inline-block',
                  animation: 'spin 0.7s linear infinite',
                }} />
                Connecting...
              </>
            ) : (
              <>Continue to Telegram →</>
            )}
          </button>
        </form>

        {/* Footer hint */}
        <p style={{
          marginTop: '1.25rem',
          fontSize: '0.75rem',
          color: 'rgba(255,255,255,0.25)',
        }}>
          Letters, numbers &amp; underscores only · max 32 characters
        </p>

        {/* Decorative bottom line */}
        <div style={{
          position: 'absolute', bottom: 0, left: '20%', right: '20%', height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(99,162,207,0.4), transparent)',
          borderRadius: '999px',
        }} />
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        input::placeholder {
          color: rgba(255,255,255,0.3);
        }
      `}</style>
    </div>
  );
};