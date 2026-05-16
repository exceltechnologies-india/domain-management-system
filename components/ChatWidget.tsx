'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircle, X, Send, Bot, User, Loader2 } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const SESSION_KEY = 'anutech_chat_messages';
const MAX_STORED = 50;

const GREETING: Message = {
  role: 'assistant',
  content: "Hi! I'm Anutech's assistant. How can I help you with domain registration or web hosting today?",
};

function loadMessages(): Message[] {
  if (typeof window === 'undefined') return [GREETING];
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return [GREETING];
    const parsed: Message[] = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [GREETING];
    // Drop a trailing empty assistant message left by an interrupted stream
    const last = parsed[parsed.length - 1];
    const clean = last.role === 'assistant' && !last.content ? parsed.slice(0, -1) : parsed;
    return clean.length > 0 ? clean : [GREETING];
  } catch {
    return [GREETING];
  }
}

export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Persist to sessionStorage on every change (survives navigation + widget close/reopen)
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && !last.content) return; // mid-stream, skip
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(messages.slice(-MAX_STORED)));
    } catch { /* storage full or unavailable */ }
  }, [messages]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      inputRef.current?.focus();
    }
  }, [isOpen, messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMessage: Message = { role: 'user', content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    const assistantMessage: Message = { role: 'assistant', content: '' };
    setMessages([...newMessages, assistantMessage]);

    try {
      const res = await fetch('/api/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
      });

      if (!res.ok || !res.body) {
        throw new Error('Request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              accumulated += parsed.text;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: accumulated };
                return updated;
              });
            }
          } catch {
            // skip malformed chunk
          }
        }
      }
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: 'Sorry, something went wrong. Please try again or contact support@anutech.in.',
        };
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="fixed bottom-6 left-4 right-auto md:left-auto md:right-6 z-50 flex flex-col items-start md:items-end gap-3">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="w-[min(320px,calc(100vw-2rem))] sm:w-96 bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden"
            style={{ maxHeight: '520px' }}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="bg-white bg-opacity-20 rounded-full p-1">
                  <Bot className="h-4 w-4 text-white" />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm">Anutech Assistant</p>
                  <p className="text-blue-100 text-xs">Domain & Hosting Help</p>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-colors"
                aria-label="Close chat"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" style={{ minHeight: '300px', maxHeight: '360px' }}>
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                >
                  <div
                    className={`flex-shrink-0 rounded-full p-1 ${
                      msg.role === 'assistant'
                        ? 'bg-primary-100'
                        : 'bg-blue-100'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <Bot className="h-3.5 w-3.5 text-primary-600" />
                    ) : (
                      <User className="h-3.5 w-3.5 text-blue-600" />
                    )}
                  </div>
                  <div
                    className={`rounded-2xl px-3 py-2 text-sm max-w-[80%] ${
                      msg.role === 'assistant'
                        ? 'bg-gray-100 text-gray-800 rounded-tl-sm'
                        : 'bg-gradient-to-r from-primary-600 to-blue-600 text-white rounded-tr-sm'
                    }`}
                  >
                    {msg.content || (
                      <span className="flex items-center gap-1 text-gray-400">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Typing…
                      </span>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="px-3 pb-3 pt-2 border-t border-gray-100">
              <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2 border border-gray-200 focus-within:border-primary-400 focus-within:ring-1 focus-within:ring-primary-200 transition-all">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about domains or hosting…"
                  disabled={isLoading}
                  className="flex-1 bg-transparent text-sm text-gray-700 placeholder-gray-400 outline-none disabled:opacity-50"
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim() || isLoading}
                  className="flex-shrink-0 bg-gradient-to-r from-primary-600 to-blue-600 hover:from-primary-700 hover:to-blue-700 disabled:opacity-40 text-white rounded-lg p-1.5 transition-all"
                  aria-label="Send message"
                >
                  {isLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <p className="text-center text-gray-400 text-xs mt-1.5">Powered by Claude AI</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toggle button */}
      <motion.button
        onClick={() => setIsOpen((v) => !v)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="bg-gradient-to-r from-primary-600 to-blue-600 hover:from-primary-700 hover:to-blue-700 text-white rounded-full p-4 shadow-xl transition-all"
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
      >
        <AnimatePresence mode="wait">
          {isOpen ? (
            <motion.div key="close" initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }} transition={{ duration: 0.15 }}>
              <X className="h-6 w-6" />
            </motion.div>
          ) : (
            <motion.div key="open" initial={{ rotate: 90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: -90, opacity: 0 }} transition={{ duration: 0.15 }}>
              <MessageCircle className="h-6 w-6" />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  );
}
