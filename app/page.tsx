'use client';

import { useState, useEffect, useCallback } from 'react';
import { WelcomeScreen } from '@/components/auth/WelcomeScreen';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { ChatArea } from '@/components/dashboard/ChatArea';
import { ChatSession } from '@/utils/types';
import { useToast } from '@/components/ui/Toast';

export default function Home() {
  const [userName, setUserName] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  const [currentView, setCurrentView] = useState<string>('new-chat');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const { show: showToast, ToastRenderer } = useToast();

  // Fetch chat sessions for user from Postgres database via API
  const fetchSessions = useCallback(async (uid: string) => {
    try {
      const res = await fetch(`/api/sessions?userId=${uid}`);
      const data = await res.json();
      if (res.ok && data.sessions) {
        setSessions(data.sessions);
        // Automatically select the most recent active chat if available
        if (data.sessions.length > 0) {
          setActiveChatId(data.sessions[0].id);
          setCurrentView('history');
        } else {
          setActiveChatId(null);
          setCurrentView('new-chat');
        }
      }
    } catch (e) {
      console.error('Failed to fetch user sessions from Postgres database:', e);
    }
  }, []);

  // Load persistent user credentials & auto-login if saved
  useEffect(() => {
    const savedName = localStorage.getItem('fa_user_name');
    const savedId   = localStorage.getItem('fa_user_id');
    if (savedName && savedId) {
      setUserName(savedName);
      setUserId(savedId);
      fetchSessions(savedId);
    }
  }, [fetchSessions]);

  /**
   * Called when the user submits the login form.
   * 1. Upserts the user record in Postgres via /api/users/register (keyed by username).
   * 2. Persists credentials to localStorage for future auto-login.
   * 3. Redirects to the Telegram bot deep link so the bot can link the chatId.
   */
  const handleSetUserName = async (name: string) => {
    try {
      const res = await fetch('/api/users/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name }),
      });
      const data = await res.json();

      if (res.ok && data.user) {
        const user = data.user;

        // Display name falls back to username for web chat UI
        const displayName = user.name || user.username;
        setUserName(displayName);
        setUserId(user.id);
        localStorage.setItem('fa_user_name', displayName);
        localStorage.setItem('fa_user_id', user.id);
        // Also store the raw username so the deep link is always correct
        localStorage.setItem('fa_username', user.username);

        // Fetch any existing web chat sessions for this user
        await fetchSessions(user.id);

        showToast(`Welcome, ${displayName}! Redirecting to Telegram…`, 'success');

        // Open the Telegram bot deep link.
        // Telegram will forward "/start <username>" to the webhook,
        // which links the user's chatId to their DB record.
        const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || 'FinHelper11_bot';
        const telegramDeepLink = `https://t.me/${botUsername}?start=${encodeURIComponent(user.username)}`;
        
        // Attempt opening in a new tab, or direct redirect if popup blocked
        const win = window.open(telegramDeepLink, '_blank', 'noopener,noreferrer');
        if (!win || win.closed || typeof win.closed === 'undefined') {
          window.location.href = telegramDeepLink;
        }
      } else {
        showToast(data.error || 'Failed to register/authenticate user', 'error');
      }
    } catch (err) {
      console.error('User register/login error:', err);
      showToast('Failed to connect to user service. Please try again.', 'error');
    }
  };

  const handleLogout = () => {
    setUserName('');
    setUserId('');
    setSessions([]);
    setActiveChatId(null);
    localStorage.removeItem('fa_user_name');
    localStorage.removeItem('fa_user_id');
  };

  const handleNewChat = () => {
    setActiveChatId(null);
    setCurrentView('new-chat');
    setSidebarOpen(false);
  };

  const handleSelectChat = (id: string) => {
    setActiveChatId(id);
    setCurrentView('history');
    setSidebarOpen(false);
  };

  const handleDeleteChat = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/sessions?id=${id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeChatId === id) {
        setActiveChatId(null);
        setCurrentView('new-chat');
      }
    } catch (err) {
      console.error('Failed to delete chat session:', err);
    }
  };

  const handleSaveSession = (updatedSession: ChatSession) => {
    setSessions((prev) => {
      const index = prev.findIndex((s) => s.id === updatedSession.id);
      if (index >= 0) {
        const copy = [...prev];
        copy[index] = updatedSession;
        return copy;
      }
      return [updatedSession, ...prev];
    });
    setActiveChatId(updatedSession.id);
  };

  if (!userName || !userId) {
    return (
      <>
        {ToastRenderer}
        <WelcomeScreen onNext={handleSetUserName} />
      </>
    );
  }

  const activeSession = sessions.find((s) => s.id === activeChatId) || null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50 relative">
      {ToastRenderer}
      <Sidebar
        currentView={currentView}
        onViewChange={setCurrentView}
        onLogout={handleLogout}
        isOpen={sidebarOpen}
        setIsOpen={setSidebarOpen}
        sessions={sessions}
        activeChatId={activeChatId}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onDeleteChat={handleDeleteChat}
      />
      <ChatArea
        userName={userName}
        userId={userId}
        onMenuToggle={() => setSidebarOpen(!sidebarOpen)}
        activeSession={activeSession}
        onSaveSession={handleSaveSession}
      />
    </div>
  );
}