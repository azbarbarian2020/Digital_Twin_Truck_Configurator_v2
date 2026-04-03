"use client";

import { useState, useEffect } from "react";
import { ArrowLeft, Save, GitCompare, HelpCircle, Sun, Moon } from "lucide-react";

interface HeaderProps {
  page: "models" | "configurator" | "compare";
  onNavigate: (page: "models" | "configurator" | "compare") => void;
  onBack: () => void;
  modelName?: string;
  savedConfigCount: number;
}

export function Header({ page, onNavigate, onBack, modelName, savedConfigCount }: HeaderProps) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const shouldBeDark = stored === "dark" || (!stored && prefersDark);
    setIsDark(shouldBeDark);
    document.documentElement.classList.toggle("dark", shouldBeDark);
  }, []);

  const toggleDark = () => {
    const newDark = !isDark;
    setIsDark(newDark);
    document.documentElement.classList.toggle("dark", newDark);
    localStorage.setItem("theme", newDark ? "dark" : "light");
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between px-4 max-w-7xl mx-auto">
        <div className="flex items-center gap-4">
          {page !== "models" && (
            <button 
              onClick={onBack}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Models
            </button>
          )}
          
          <div className="flex items-center gap-3">
            <img 
              src="/logo.png" 
              alt="Digital Twin" 
              className="h-10 w-auto"
            />
            {page === "configurator" && modelName && (
              <span className="text-lg font-semibold">{modelName}</span>
            )}
          </div>
        </div>
        
        <nav className="flex items-center gap-2">
          <button 
            onClick={() => onNavigate("compare")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              page === "compare" 
                ? "bg-primary text-primary-foreground" 
                : "hover:bg-muted"
            }`}
          >
            <GitCompare className="h-4 w-4" />
            Compare
            {savedConfigCount > 0 && (
              <span className="ml-1 bg-accent text-accent-foreground text-xs px-1.5 py-0.5 rounded-full">
                {savedConfigCount}
              </span>
            )}
          </button>
          
          <button className="p-2 hover:bg-muted rounded-lg transition-colors">
            <HelpCircle className="h-5 w-5 text-muted-foreground" />
          </button>
          
          <button 
            onClick={toggleDark}
            className="p-2 hover:bg-muted rounded-lg transition-colors"
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? (
              <Sun className="h-5 w-5 text-muted-foreground" />
            ) : (
              <Moon className="h-5 w-5 text-muted-foreground" />
            )}
          </button>
        </nav>
      </div>
    </header>
  );
}
