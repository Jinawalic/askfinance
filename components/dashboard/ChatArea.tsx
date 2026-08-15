import React, { useState, useRef, useEffect } from 'react';
import { Send as PaperAirplaneIcon, Plus as PlusIcon, Loader2, FileText } from 'lucide-react';
import { Message, ChatSession, FinancialSummaryData } from '@/utils/types';

interface ChatAreaProps {
    userName: string;
    userId?: string;
    onMenuToggle: () => void;
    activeSession: ChatSession | null;
    onSaveSession: (session: ChatSession) => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
    userName,
    userId,
    onMenuToggle,
    activeSession,
    onSaveSession,
}) => {
    const [message, setMessage] = useState('');
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [messages, setMessages] = useState<Message[]>(activeSession ? activeSession.messages : []);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(activeSession ? activeSession.id : null);
    const [financialSummary, setFinancialSummary] = useState<FinancialSummaryData | undefined>(activeSession?.financialSummary);
    const [isLoading, setIsLoading] = useState(false);
    const [loadingStatus, setLoadingStatus] = useState<string>('');

    const fileInputRef = useRef<HTMLInputElement>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    // Sync state when activeSession changes
    useEffect(() => {
        if (activeSession) {
            setMessages(activeSession.messages);
            setCurrentSessionId(activeSession.id);
            setFinancialSummary(activeSession.financialSummary);
        } else {
            setMessages([]);
            setCurrentSessionId(null);
            setFinancialSummary(undefined);
        }
    }, [activeSession]);

    // Scroll chat to bottom on new messages
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, loadingStatus]);

    const handlePlusClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const file = e.target.files[0];
            if (!file.name.toLowerCase().endsWith('.pdf')) {
                alert('Please upload a PDF bank statement.');
                return;
            }
            setSelectedFile(file);
        }
    };

    const generateChatTitle = (text: string, file: File | null): string => {
        if (file) return `Statement: ${file.name}`;
        if (text) {
            const cleanText = text.trim();
            return cleanText.length <= 35 ? cleanText : cleanText.substring(0, 32) + '...';
        }
        return 'Financial Consultation';
    };

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        if ((!message.trim() && !selectedFile) || isLoading) return;

        const userText = message.trim();
        const attachedFile = selectedFile;

        setMessage('');
        setSelectedFile(null);

        let activeSessionId = currentSessionId;
        let updatedSummary = financialSummary;
        let currentMessagesList: Message[] = [...messages];

        setIsLoading(true);

        // 1. Process PDF file upload if attached
        if (attachedFile) {
            setLoadingStatus('Processing PDF & generating Voyage AI vectors...');

            const formData = new FormData();
            formData.append('file', attachedFile);
            if (activeSessionId) {
                formData.append('sessionId', activeSessionId);
            }
            if (userId) {
                formData.append('userId', userId);
            }

            try {
                const uploadRes = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData,
                });
                const uploadData = await uploadRes.json();

                if (!uploadRes.ok) {
                    throw new Error(uploadData.error || 'Failed to upload bank statement');
                }

                activeSessionId = uploadData.sessionId;
                setCurrentSessionId(uploadData.sessionId);
                updatedSummary = uploadData.summary;
                setFinancialSummary(uploadData.summary);

                // Append user upload message
                const uploadMsg: Message = {
                    id: Date.now().toString(),
                    text: userText || `Uploaded PDF bank statement: ${attachedFile.name}`,
                    sender: 'user',
                    fileName: attachedFile.name,
                };

                currentMessagesList = [...currentMessagesList, uploadMsg];
                setMessages(currentMessagesList);

            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : 'Upload failed';
                alert(errorMessage);
                setIsLoading(false);
                setLoadingStatus('');
                return;
            }
        } else {
            // Normal message push
            const userMsg: Message = {
                id: Date.now().toString(),
                text: userText,
                sender: 'user',
            };
            currentMessagesList = [...currentMessagesList, userMsg];
            setMessages(currentMessagesList);
        }

        // 2. Query Anthropic Claude via streaming API
        setLoadingStatus('Finance AI is analyzing your data...');

        const aiMsgId = (Date.now() + 1).toString();
        const initialAiMsg: Message = {
            id: aiMsgId,
            text: '',
            sender: 'ai',
        };

        currentMessagesList = [...currentMessagesList, initialAiMsg];
        setMessages(currentMessagesList);

        try {
            const chatRes = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: userText || 'Please give me a complete financial analysis of my uploaded bank statement.',
                    sessionId: activeSessionId,
                    userId: userId,
                }),
            });

            const returnedSessionId = chatRes.headers.get('x-session-id') || activeSessionId;
            if (returnedSessionId) {
                activeSessionId = returnedSessionId;
                setCurrentSessionId(returnedSessionId);
            }

            // If request failed, read error body and throw
            if (!chatRes.ok) {
                let errMsg = `Server error (${chatRes.status})`;
                try {
                    const errData = await chatRes.json();
                    errMsg = errData.details || errData.error || errMsg;
                    console.error('[Anthropic API Error Details from Server]:', errData);
                } catch {
                    errMsg = await chatRes.text().catch(() => errMsg);
                    console.error('[Anthropic API Server Error Text]:', errMsg);
                }
                throw new Error(errMsg);
            }

            if (!chatRes.body) {
                console.error('[Anthropic Stream Error]: Response body is missing from AI server stream.');
                throw new Error('No response body stream received from Anthropic AI server');
            }

            const reader = chatRes.body.getReader();
            const decoder = new TextDecoder();
            let accumulatedText = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    accumulatedText += chunk;

                    setMessages((prev) =>
                        prev.map((msg) => (msg.id === aiMsgId ? { ...msg, text: accumulatedText } : msg))
                    );
                }
            } catch (streamReadErr) {
                console.error('[Anthropic Stream Reader Exception]:', streamReadErr);
                const streamErrMessage = streamReadErr instanceof Error ? streamReadErr.message : String(streamReadErr);
                throw new Error(`Error while reading Anthropic stream: ${streamErrMessage}`);
            }

            // If AI returned nothing at all, fallback to friendly message
            if (!accumulatedText.trim()) {
                console.warn('[Anthropic Warning]: Stream completed with no content.');
                accumulatedText = 'Pls I cant answer you now. Try again later.';
            }

            const finalMessages = currentMessagesList.map((msg) =>
                msg.id === aiMsgId ? { ...msg, text: accumulatedText } : msg
            );
            setMessages(finalMessages);

            // Sync full session to parent state
            const title = activeSession
                ? activeSession.title
                : generateChatTitle(userText, attachedFile);

            if (activeSessionId) {
                onSaveSession({
                    id: activeSessionId,
                    title: title,
                    messages: finalMessages,
                    createdAt: activeSession ? activeSession.createdAt : Date.now(),
                    financialSummary: updatedSummary,
                });
            }

        } catch (err: unknown) {
            console.error('❌ [Anthropic Client Error Caught]:', err);
            const fallbackText = 'Pls I cant answer you now. Try again later.';
            const fallbackMessages = currentMessagesList.map((msg) =>
                msg.id === aiMsgId ? { ...msg, text: fallbackText } : msg
            );
            setMessages(fallbackMessages);

            const title = activeSession
                ? activeSession.title
                : generateChatTitle(userText, attachedFile);

            if (activeSessionId) {
                onSaveSession({
                    id: activeSessionId,
                    title: title,
                    messages: fallbackMessages,
                    createdAt: activeSession ? activeSession.createdAt : Date.now(),
                    financialSummary: updatedSummary,
                });
            }
        } finally {
            setIsLoading(false);
            setLoadingStatus('');
        }
    };

    const hasChatStarted = messages.length > 0 || selectedFile !== null;

    return (
        <section className="flex-1 flex flex-col h-full max-h-screen w-full bg-white relative overflow-hidden">
            {/* Top Navigation Header */}
            <header className="h-16 border-b border-gray-100 flex items-center justify-between px-4 sm:px-8 bg-white z-10 shrink-0">
                <div className="flex items-center gap-3">
                    <button
                        onClick={onMenuToggle}
                        className="p-2 -ml-2 rounded-lg text-gray-500 hover:bg-gray-50 active:bg-gray-100 lg:hidden"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                        </svg>
                    </button>
                    <div>
                        <h1 className="font-bold text-base sm:text-lg text-[#0b3c5d]">
                            Finance AI
                        </h1>
                    </div>
                </div>

                <div className="bg-[#eaf2f8] text-[#4682b4] font-medium px-3 sm:px-4 py-1.5 rounded-full text-xs sm:text-sm max-w-[120px] sm:max-w-none truncate">
                    {userName}
                </div>
            </header>

            {/* Main Content Area */}
            <main className={`flex-1 overflow-y-auto py-4 px-4 sm:p-8 flex flex-col min-h-0 transition-all duration-500 ${hasChatStarted ? 'justify-start' : 'justify-center items-center'
                }`}>
                {/* Initial Welcome Text */}
                {!hasChatStarted && (
                    <div className="text-center space-y-2 mb-8 animate-fade-in w-full max-w-xl">
                        <div className="w-16 h-16 bg-[#eaf2f8] text-[#4682b4] text-3xl rounded-full flex items-center justify-center mx-auto mb-4 border border-[#63a2cf]/30 shadow-inner">
                            🤖
                        </div>
                        <h2 className="text-xl sm:text-2xl font-bold text-gray-800">
                            Welcome {userName}!
                        </h2>
                        <p className="text-gray-500 text-sm sm:text-base px-4">
                            Upload your bank statement or ask any personal finance question.
                        </p>
                    </div>
                )}

                {/* Render Chat Messages Timeline */}
                {messages.length > 0 && (
                    <div className="w-full max-w-3xl mx-auto space-y-4 mb-2">
                        {messages.map((msg) => (
                            <div
                                key={msg.id}
                                className={`flex flex-col max-w-[85%] sm:max-w-[80%] ${msg.sender === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
                                    }`}
                            >
                                <div className={`p-4 rounded-2xl text-sm sm:text-base shadow-sm ${msg.sender === 'user'
                                    ? 'bg-[#63a2cf] text-white rounded-tr-none'
                                    : 'bg-gray-100 text-gray-800 rounded-tl-none border border-gray-200'
                                    }`}>
                                    {msg.text ? (
                                        <div className="whitespace-pre-wrap break-words">{msg.text}</div>
                                    ) : (
                                        <div className="flex items-center gap-2 text-gray-400 py-1">
                                            <Loader2 className="w-4 h-4 animate-spin text-[#63a2cf]" />
                                            <span className="text-xs">Claude is thinking...</span>
                                        </div>
                                    )}
                                    {msg.fileName && (
                                        <div className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md mt-2 ${msg.sender === 'user' ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-700'
                                            }`}>
                                            <FileText className="w-3.5 h-3.5" /> {msg.fileName}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}

                        {/* Animated Loading Status */}
                        {isLoading && loadingStatus && (
                            <div className="flex items-center gap-2 text-xs text-gray-500 bg-gray-50 border border-gray-100 px-3 py-2 rounded-xl w-fit mx-auto animate-pulse">
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#63a2cf]" />
                                <span>{loadingStatus}</span>
                            </div>
                        )}

                        <div ref={chatEndRef} />
                    </div>
                )}

                {/* Selected File Preview when Idle */}
                {selectedFile && !messages.length && (
                    <div className="inline-flex items-center gap-2 bg-blue-50 border border-blue-200 text-blue-800 text-xs sm:text-sm px-3.5 py-2 rounded-xl mb-4 animate-fade-in">
                        <FileText className="w-4 h-4 text-[#63a2cf]" />
                        <span className="font-medium truncate max-w-[200px]">{selectedFile.name}</span>
                        <button
                            type="button"
                            onClick={() => setSelectedFile(null)}
                            className="text-gray-400 hover:text-red-500 font-bold ml-1"
                        >
                            &times;
                        </button>
                    </div>
                )}

                {/* Input Box when Idle */}
                {!hasChatStarted && (
                    <div className="w-full max-w-2xl transition-all duration-500">
                        <ChatInputForm
                            message={message}
                            setMessage={setMessage}
                            handleSend={handleSend}
                            fileInputRef={fileInputRef}
                            handleFileChange={handleFileChange}
                            handlePlusClick={handlePlusClick}
                            isLoading={isLoading}
                        />
                    </div>
                )}
            </main>

            {/* Bottom Footer Input Box when Active */}
            {hasChatStarted && (
                <footer className="p-3 sm:p-6 border-t border-gray-100 bg-white shrink-0">
                    <div className="max-w-3xl mx-auto">
                        {selectedFile && (
                            <div className="inline-flex items-center gap-2 bg-blue-50 border border-blue-200 text-blue-800 text-xs sm:text-sm px-3 py-1.5 rounded-lg mb-2">
                                <FileText className="w-4 h-4 text-[#63a2cf]" />
                                <span className="font-medium truncate max-w-[200px]">{selectedFile.name}</span>
                                <button type="button" onClick={() => setSelectedFile(null)} className="text-gray-400 hover:text-red-500 font-bold ml-1">&times;</button>
                            </div>
                        )}
                        <ChatInputForm
                            message={message}
                            setMessage={setMessage}
                            handleSend={handleSend}
                            fileInputRef={fileInputRef}
                            handleFileChange={handleFileChange}
                            handlePlusClick={handlePlusClick}
                            isLoading={isLoading}
                        />
                    </div>
                </footer>
            )}
        </section>
    );
};

// Clean Financial Summary Component (using Naira ₦)
const SummaryCard: React.FC<{ summary: FinancialSummaryData }> = ({ summary }) => (
    <div className="bg-gradient-to-br from-[#0b3c5d] to-[#1d5c88] text-white p-5 rounded-2xl shadow-sm my-2 space-y-4">
        <div className="flex justify-between items-center border-b border-white/20 pb-3">
            <h3 className="font-semibold text-sm sm:text-base flex items-center gap-2">
                📊 Bank Statement Overview
            </h3>
            <span className="bg-white/20 text-xs px-2.5 py-1 rounded-full font-medium">
                Savings Rate: {summary.savingsRatePercent}%
            </span>
        </div>
        <div className="grid grid-cols-3 gap-2.5 text-center">
            <div className="bg-white/10 p-2.5 rounded-xl backdrop-blur-sm">
                <p className="text-[11px] text-blue-200 uppercase font-medium">Inflow</p>
                <p className="font-bold text-xs sm:text-sm text-emerald-300">
                    ₦{summary.totalInflow.toLocaleString()}
                </p>
            </div>
            <div className="bg-white/10 p-2.5 rounded-xl backdrop-blur-sm">
                <p className="text-[11px] text-blue-200 uppercase font-medium">Outflow</p>
                <p className="font-bold text-xs sm:text-sm text-rose-300">
                    ₦{summary.totalOutflow.toLocaleString()}
                </p>
            </div>
            <div className="bg-white/10 p-2.5 rounded-xl backdrop-blur-sm">
                <p className="text-[11px] text-blue-200 uppercase font-medium">Net Savings</p>
                <p className="font-bold text-xs sm:text-sm text-amber-300">
                    ₦{summary.netSavings.toLocaleString()}
                </p>
            </div>
        </div>
        {summary.categories && Object.keys(summary.categories).length > 0 && (
            <div className="pt-1">
                <p className="text-xs text-blue-200 mb-1.5 font-medium">Expense Categories:</p>
                <div className="flex flex-wrap gap-1.5">
                    {Object.entries(summary.categories).map(([cat, amt]) => amt > 0 && (
                        <span key={cat} className="bg-black/20 text-[11px] px-2 py-0.5 rounded-md">
                            {cat}: <strong className="text-white">₦{amt.toLocaleString()}</strong>
                        </span>
                    ))}
                </div>
            </div>
        )}
    </div>
);

interface InputFormProps {
    message: string;
    setMessage: (val: string) => void;
    handleSend: (e: React.FormEvent) => void;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    handlePlusClick: () => void;
    isLoading: boolean;
}

const ChatInputForm: React.FC<InputFormProps> = ({
    message,
    setMessage,
    handleSend,
    fileInputRef,
    handleFileChange,
    handlePlusClick,
    isLoading
}) => {
    return (
        <form onSubmit={handleSend} className="w-full flex items-center gap-3 relative">
            <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
                accept=".pdf"
            />

            <button
                type="button"
                onClick={handlePlusClick}
                disabled={isLoading}
                title="Upload PDF statement"
                className="absolute left-3 p-2 text-gray-400 hover:text-gray-600 active:scale-95 transition-all z-10 disabled:opacity-50"
            >
                <PlusIcon className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2.5]" />
            </button>

            <input
                type="text"
                placeholder="Ask Finance AI a question or upload a PDF statement..."
                value={message}
                disabled={isLoading}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full pl-12 pr-14 py-3 sm:py-4 border border-gray-200 rounded-full focus:outline-none focus:ring-2 focus:ring-[#63a2cf]/50 bg-[#fafafa] text-sm sm:text-base text-gray-950 placeholder-gray-400 transition-all shadow-sm disabled:bg-gray-100"
            />

            <button
                type="submit"
                disabled={isLoading}
                className="absolute right-1.5 p-2.5 sm:p-3 bg-[#63a2cf] text-white rounded-full hover:bg-[#5291be] transition-colors disabled:opacity-50"
            >
                {isLoading ? (
                    <Loader2 className="w-4 sm:w-5 h-4 sm:h-5 animate-spin" />
                ) : (
                    <PaperAirplaneIcon className="w-4 sm:w-5 h-4 sm:h-5 transform rotate-45 -translate-y-0.5 translate-x-0.5" />
                )}
            </button>
        </form>
    );
};