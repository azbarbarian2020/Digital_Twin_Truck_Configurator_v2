"use client";

import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, Bot, User, Loader2, CheckCircle } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  recommendations?: Recommendation[];
}

interface Recommendation {
  optionId: string;
  optionName: string;
  path: string;
  cost: number;
  reason: string;
  action?: 'add' | 'remove' | 'downgrade' | 'upgrade';
}

interface OptionDetail {
  optionId: string;
  optionName: string;
  cost: number;
  system: string;
  subsystem: string;
  componentGroup: string;
}

interface ModelInfo {
  modelId: string;
  modelName: string;
  baseMsrp: number;
}

interface ChatPanelProps {
  modelId?: string;
  modelInfo?: ModelInfo;
  selectedOptions?: OptionDetail[];
  onApplyOptions?: (optionIds: string[], action: 'add' | 'remove' | 'replace') => void;
  sessionId?: string;
}

export function ChatPanel({ modelId, modelInfo, selectedOptions, onApplyOptions, sessionId }: ChatPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "Hi! I'm your truck configuration assistant. Ask me anything about truck specifications, options, compatibility, or get recommendations based on your needs. I can also apply my recommendations directly to your configuration!"
    }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastUserRequest, setLastUserRequest] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setMessages([{
      role: "assistant",
      content: "Hi! I'm your truck configuration assistant. Ask me anything about truck specifications, options, compatibility, or get recommendations based on your needs. I can also apply my recommendations directly to your configuration!"
    }]);
    setLastUserRequest("");
    setInput("");
    setLoading(false);
  }, [modelId]);

  useEffect(() => {
    if (!isDragging) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y
      });
    };
    
    const handleMouseUp = () => {
      setIsDragging(false);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    setIsDragging(true);
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  function getLastRecommendations(): Recommendation[] | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].recommendations && messages[i].recommendations!.length > 0) {
        return messages[i].recommendations;
      }
    }
    return undefined;
  }

  function isConfirmation(text: string): boolean {
    const confirmations = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'apply', 'do it', 'go ahead', 'please', 'apply them', 'apply all', 'sounds good', 'let\'s do it'];
    const lower = text.toLowerCase().trim();
    return confirmations.some(c => lower === c || lower.startsWith(c + ' ') || lower.endsWith(' ' + c));
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    
    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMessage }]);

    if (isConfirmation(userMessage)) {
      const pendingRecs = getLastRecommendations();
      if (pendingRecs && pendingRecs.length > 0 && onApplyOptions) {
        const optionIds = pendingRecs.filter(r => r.optionId).map(r => r.optionId);
        if (optionIds.length > 0) {
          onApplyOptions(optionIds, 'add');
          if (lastUserRequest) {
            saveOptimizationToDb(lastUserRequest);
          }
          setMessages(prev => [...prev, {
            role: "assistant",
            content: `✅ Done! I've applied ${optionIds.length} recommendation(s) to your configuration. You can see the changes in the configurator panel.`
          }]);
          return;
        }
      }
    }

    setLastUserRequest(userMessage);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          modelId,
          modelInfo,
          selectedOptions
        })
      });

      const data = await res.json();
      setMessages(prev => [...prev, { 
        role: "assistant", 
        content: data.response || "I couldn't process that request. Please try again.",
        recommendations: data.recommendations
      }]);
    } catch (err) {
      setMessages(prev => [...prev, { 
        role: "assistant", 
        content: "Sorry, I encountered an error. Please try again."
      }]);
    } finally {
      setLoading(false);
    }
  }

  async function saveOptimizationToDb(userRequest: string) {
    if (!sessionId || !modelId) return;
    try {
      await fetch("/api/chat-history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          optimizationRequest: userRequest
        })
      });
    } catch (err) {
      console.error("Error saving optimization:", err);
    }
  }

  function handleApplyRecommendations(recommendations: Recommendation[]) {
    if (!onApplyOptions) return;
    
    const allOptionIds = recommendations.filter(r => r.optionId).map(r => r.optionId);
    
    if (allOptionIds.length > 0) {
      onApplyOptions(allOptionIds, 'replace');
      if (lastUserRequest) {
        saveOptimizationToDb(lastUserRequest);
      }
    }
    
    setMessages(prev => [...prev, {
      role: "assistant",
      content: `✅ Applied ${allOptionIds.length} recommendation(s) to your configuration!`
    }]);
  }

  function handleApplySingle(recommendation: Recommendation) {
    if (!onApplyOptions) return;
    
    onApplyOptions([recommendation.optionId], 'replace');
    if (lastUserRequest) {
      saveOptimizationToDb(lastUserRequest);
    }
    
    const verb = recommendation.action === 'upgrade' ? 'Upgraded to' :
                 recommendation.action === 'downgrade' ? 'Downgraded to' : 'Applied';
    setMessages(prev => [...prev, {
      role: "assistant",
      content: `✅ ${verb} **${recommendation.optionName}**!`
    }]);
  }

  function renderContent(content: string) {
    return content.split('\n').map((line, i) => {
      const boldMatch = line.match(/\*\*(.*?)\*\*/g);
      if (boldMatch) {
        let processed = line;
        boldMatch.forEach(match => {
          const text = match.replace(/\*\*/g, '');
          processed = processed.replace(match, `<strong>${text}</strong>`);
        });
        return <p key={i} dangerouslySetInnerHTML={{ __html: processed }} className="mb-1" />;
      }
      return <p key={i} className="mb-1">{line || '\u00A0'}</p>;
    });
  }

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 w-14 h-14 bg-primary text-primary-foreground rounded-full shadow-lg hover:bg-primary/90 transition-all hover:scale-105 flex items-center justify-center z-50"
          title="Chat with AI Assistant"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}

      {isOpen && (
        <div 
          className="fixed w-[420px] h-[550px] bg-background border rounded-xl shadow-2xl flex flex-col z-50"
          style={{
            bottom: position.x === 0 && position.y === 0 ? '24px' : 'auto',
            right: position.x === 0 && position.y === 0 ? '24px' : 'auto',
            left: position.x !== 0 || position.y !== 0 ? position.x : 'auto',
            top: position.x !== 0 || position.y !== 0 ? position.y : 'auto'
          }}
        >
          <div 
            className="flex items-center justify-between p-4 border-b bg-primary text-primary-foreground rounded-t-xl cursor-move select-none"
            onMouseDown={handleMouseDown}
          >
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              <span className="font-semibold">Configuration Assistant</span>
              <span className="text-xs opacity-70">(drag to move)</span>
            </div>
            <button onClick={() => setIsOpen(false)} className="p-1 hover:bg-white/20 rounded">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}>
                  {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                </div>
                <div className="max-w-[85%] space-y-2">
                  <div className={`p-3 rounded-lg text-sm ${
                    msg.role === "user" 
                      ? "bg-primary text-primary-foreground" 
                      : "bg-muted"
                  }`}>
                    {renderContent(msg.content)}
                  </div>
                  
                  {msg.recommendations && msg.recommendations.length > 0 && (
                    <div className="space-y-2">
                      {msg.recommendations.map((rec, j) => {
                        const isRemoval = rec.action === 'remove' || rec.action === 'downgrade';
                        const bgColor = isRemoval ? 'bg-orange-50 border-orange-200' : 'bg-blue-50 border-blue-200';
                        const textColor = isRemoval ? 'text-orange-900' : 'text-blue-900';
                        const subTextColor = isRemoval ? 'text-orange-700' : 'text-blue-700';
                        const btnColor = isRemoval ? 'bg-orange-600 hover:bg-orange-700' : 'bg-blue-600 hover:bg-blue-700';
                        const actionLabel = rec.action === 'remove' ? 'Remove This Option' : rec.action === 'downgrade' ? 'Apply Downgrade' : 'Apply This Option';
                        
                        return (
                          <div key={j} className={`${bgColor} border rounded-lg p-2 text-xs`}>
                            <div className="flex items-center gap-1">
                              {isRemoval && <span className="text-orange-600 font-bold">↓</span>}
                              <div className={`font-semibold ${textColor}`}>{rec.optionName}</div>
                            </div>
                            {rec.path && <div className={`${subTextColor} text-[10px] mb-1`}>{rec.path}</div>}
                            <div className={`${subTextColor} mb-2`}>
                              {rec.reason} • {rec.cost < 0 ? `-$${Math.abs(rec.cost).toLocaleString()}` : `$${rec.cost.toLocaleString()}`}
                            </div>
                            {rec.optionId && (
                              <button
                                onClick={() => handleApplySingle(rec)}
                                className={`w-full py-1 px-2 ${btnColor} text-white rounded text-xs transition-colors flex items-center justify-center gap-1`}
                              >
                                <CheckCircle className="h-3 w-3" />
                                {actionLabel}
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {msg.recommendations.filter(r => r.optionId).length > 1 && (
                        <button
                          onClick={() => handleApplyRecommendations(msg.recommendations!)}
                          className="w-full py-2 px-3 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors flex items-center justify-center gap-2"
                        >
                          <CheckCircle className="h-4 w-4" />
                          Apply All {msg.recommendations.filter(r => r.optionId).length} Actionable Recommendations
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex gap-2">
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="bg-muted p-3 rounded-lg">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-4 border-t">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSend()}
                placeholder="Ask about trucks, options, specs..."
                className="flex-1 px-3 py-2 border rounded-lg text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                disabled={loading}
              />
              <button
                onClick={handleSend}
                disabled={loading || !input.trim()}
                className="p-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
