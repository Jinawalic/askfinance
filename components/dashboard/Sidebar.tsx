import React, { useState } from 'react';
import { Button } from '../ui/Button';
import {
    Plus as PlusIcon,
    MessageSquare as ChatBubbleLeftRightIcon,
    Brain as CognitionIcon,
    LogOut as ArrowLeftStartOnRectangleIcon,
    ChevronDown,
    ChevronRight,
    Trash2,
    MessageCircle
} from 'lucide-react';
import { ChatSession } from '@/utils/types';

interface SidebarProps {
    currentView: string;
    onViewChange: (view: string) => void;
    onLogout: () => void;
    isOpen: boolean;
    setIsOpen: (isOpen: boolean) => void;
    sessions: ChatSession[];
    activeChatId: string | null;
    onNewChat: () => void;
    onSelectChat: (id: string) => void;
    onDeleteChat: (id: string, e: React.MouseEvent) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
    currentView,
    onViewChange,
    onLogout,
    isOpen,
    setIsOpen,
    sessions,
    activeChatId,
    onNewChat,
    onSelectChat,
    onDeleteChat,
}) => {
    const [historyOpen, setHistoryOpen] = useState(false);

    return (
        <>
            {/* Mobile Backdrop Overlay */}
            {isOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
                    onClick={() => setIsOpen(false)}
                />
            )}

            {/* Sidebar Container */}
            <aside className={`
                fixed inset-y-0 left-0 z-50 w-64 h-full border-r border-gray-100 flex flex-col justify-between p-4 bg-white transition-transform duration-300 ease-in-out
                lg:static lg:translate-x-0
                ${isOpen ? 'translate-x-0' : '-translate-x-full'}
            `}>
                <div className="space-y-6 flex-1 overflow-y-auto flex flex-col">
                    {/* App Logo & Mobile Close Button */}
                    <div className="flex items-center justify-between px-2 pt-2 shrink-0">
                        <div className="flex items-center gap-3 text-[#4682b4] font-bold text-xl">
                            <div className="w-8 h-8 rounded-full border-2 border-current flex items-center justify-center">🤖</div>
                            Finance AI
                        </div>
                        {/* Close button inside mobile menu */}
                        <button
                            onClick={() => setIsOpen(false)}
                            className="p-1 text-gray-400 hover:text-gray-600 lg:hidden"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    {/* Navigation Links */}
                    <nav className="space-y-1.5 shrink-0">
                        {/* New Chat Button */}
                        <button
                            onClick={onNewChat}
                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${currentView === 'new-chat' && activeChatId === null
                                ? 'bg-[#63a2cf] text-white shadow-sm'
                                : 'text-gray-700 hover:bg-gray-50'
                                }`}
                        >
                            <PlusIcon className="w-5 h-5" />
                            New Chat
                        </button>

                        {/* Chat History Dropdown Accordion */}
                        <div>
                            <button
                                onClick={() => setHistoryOpen(!historyOpen)}
                                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition-all ${currentView === 'history'
                                    ? 'text-[#4682b4] bg-[#eaf2f8]/60 font-semibold'
                                    : 'text-gray-700 hover:bg-gray-50'
                                    }`}
                            >
                                <div className="flex items-center gap-3">
                                    <ChatBubbleLeftRightIcon className="w-5 h-5 text-gray-600" />
                                    <span>Chat History</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    {sessions.length > 0 && (
                                        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-normal">
                                            {sessions.length}
                                        </span>
                                    )}
                                    {historyOpen ? (
                                        <ChevronDown className="w-4 h-4 text-gray-400" />
                                    ) : (
                                        <ChevronRight className="w-4 h-4 text-gray-400" />
                                    )}
                                </div>
                            </button>

                            {/* Dropdown Items List */}
                            {historyOpen && (
                                <div className="mt-1 ml-3 pl-3 border-l-2 border-gray-100 space-y-1 max-h-60 overflow-y-auto pr-1">
                                    {sessions.length === 0 ? (
                                        <div className="px-3 py-2 text-xs text-gray-400 italic flex items-center gap-2">
                                            <MessageCircle className="w-3.5 h-3.5" />
                                            No previous chats
                                        </div>
                                    ) : (
                                        sessions.map((session) => {
                                            const isActive = activeChatId === session.id;
                                            return (
                                                <div
                                                    key={session.id}
                                                    onClick={() => onSelectChat(session.id)}
                                                    className={`group relative flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium cursor-pointer transition-colors ${isActive
                                                        ? 'bg-[#63a2cf] text-white shadow-sm'
                                                        : 'text-gray-600 hover:bg-gray-100/80 hover:text-gray-900'
                                                        }`}
                                                >
                                                    <span className="truncate pr-4" title={session.title}>
                                                        {session.title || 'Untitled Chat'}
                                                    </span>
                                                    <button
                                                        onClick={(e) => onDeleteChat(session.id, e)}
                                                        title="Delete chat"
                                                        className={`opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/20 transition-opacity ${isActive ? 'text-white' : 'text-gray-400 hover:text-red-500'
                                                            }`}
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Settings Button */}
                        <button
                            onClick={() => {
                                onViewChange('settings');
                                setIsOpen(false);
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${currentView === 'settings'
                                ? 'bg-[#63a2cf] text-white shadow-sm'
                                : 'text-gray-700 hover:bg-gray-50'
                                }`}
                        >
                            <CognitionIcon className="w-5 h-5" />
                            Settings
                        </button>
                    </nav>
                </div>

                {/* Logout Button */}
                <div className="pt-4 border-t border-gray-100 shrink-0">
                    <Button variant="ghost" onClick={onLogout} className="w-full justify-start text-gray-600">
                        <ArrowLeftStartOnRectangleIcon className="w-5 h-5" />
                        Logout
                    </Button>
                </div>
            </aside>
        </>
    );
};