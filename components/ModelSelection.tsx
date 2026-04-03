"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { Model } from "@/app/page";
import { formatCurrency, formatWeight } from "@/lib/utils";
import { Truck, ChevronRight, HelpCircle, X, Info, Zap, Fuel, Armchair, Weight, BedDouble, DollarSign, Check, Sparkles, Star, TrendingUp } from "lucide-react";

interface ModelSelectionProps {
  models: Model[];
  onSelectModel: (model: Model) => void;
}

export function ModelSelection({ models, onSelectModel }: ModelSelectionProps) {
  const [showFindModel, setShowFindModel] = useState(false);
  const [recommendation, setRecommendation] = useState<Model | null>(null);

  return (
    <div className="container max-w-7xl mx-auto px-4 py-12">
      <div className="flex items-center justify-center gap-8 mb-12">
        <div className="flex-shrink-0">
          <img 
            src="/logo.png" 
            alt="Digital Twin Truck Configurator" 
            width={180}
            height={180}
            className="rounded-lg shadow-lg"
          />
        </div>
        <div className="text-left">
          <h1 className="text-4xl font-bold tracking-tight mb-3">SELECT YOUR MODEL</h1>
          <p className="text-muted-foreground text-lg">
            Choose a base model to start building your perfect truck
          </p>
          <p className="text-sm text-muted-foreground/70 mt-2">
            Powered by Snowflake Cortex AI for intelligent configuration assistance
          </p>
        </div>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {models.map((model) => (
          <ModelCard 
            key={model.MODEL_ID} 
            model={model} 
            onSelect={() => onSelectModel(model)} 
          />
        ))}
        
        <div 
          className="bg-gradient-to-br from-muted to-background border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center min-h-[400px] cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => setShowFindModel(true)}
        >
          <HelpCircle className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">Can't Decide?</h3>
          <p className="text-muted-foreground text-sm mb-4">
            Tell us your requirements and we'll recommend the best fit.
          </p>
          <button className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
            Find My Model →
          </button>
        </div>
      </div>

      {showFindModel && (
        <FindModelModal 
          models={models}
          onClose={() => setShowFindModel(false)}
          onSelectModel={(model) => {
            setShowFindModel(false);
            onSelectModel(model);
          }}
        />
      )}
    </div>
  );
}

function ModelCard({ model, onSelect }: { model: Model; onSelect: () => void }) {
  const shortName = model.MODEL_NM.split(" ").slice(-1)[0];
  const [imageError, setImageError] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (showTooltip && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const tooltipHeight = 340;
      const viewportHeight = window.innerHeight;
      
      let top = rect.bottom + 8;
      if (top + tooltipHeight > viewportHeight - 20) {
        top = Math.max(20, viewportHeight - tooltipHeight - 20);
      }
      
      setTooltipPosition({
        top,
        left: Math.min(rect.right - 320, window.innerWidth - 340),
      });
    }
  }, [showTooltip]);

  useEffect(() => {
    if (showTooltip) {
      const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as Element;
        if (!target.closest('.tooltip-portal') && !buttonRef.current?.contains(target)) {
          setShowTooltip(false);
        }
      };
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showTooltip]);
  
  return (
    <div 
      className="group bg-card border rounded-xl overflow-hidden hover:shadow-lg hover:-translate-y-1 transition-all duration-300 cursor-pointer"
      onClick={onSelect}
    >
      <div className="aspect-[16/10] bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center relative overflow-hidden">
        {!imageError ? (
          <img 
            src={`/${model.MODEL_ID}.png`} 
            alt={model.MODEL_NM}
            className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-300"
            onError={() => setImageError(true)}
          />
        ) : (
          <Truck className="h-24 w-24 text-slate-400" />
        )}
        <div className="absolute top-3 right-3 bg-black/70 text-white text-xs px-2 py-1 rounded z-10">
          {shortName}
        </div>
      </div>
      
      <div className="p-5">
        <div className="flex items-start justify-between gap-2 mb-1">
          <h3 className="text-lg font-bold">{model.MODEL_NM}</h3>
          <div className="relative">
            <button
              ref={buttonRef}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setShowTooltip(!showTooltip);
              }}
            >
              <Info className="h-4 w-4" />
            </button>
            {showTooltip && typeof document !== 'undefined' && createPortal(
              <div 
                className="tooltip-portal fixed w-80 max-h-80 p-4 bg-white border rounded-lg shadow-xl z-[9999] text-sm text-gray-700"
                style={{ top: tooltipPosition.top, left: tooltipPosition.left }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="absolute top-2 right-2 p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowTooltip(false);
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
                <div className="pr-6 overflow-y-auto max-h-64">
                  {model.TRUCK_DESCRIPTION}
                </div>
              </div>,
              document.body
            )}
          </div>
        </div>
        <p className="text-2xl font-bold text-primary mb-3">
          Starting {formatCurrency(model.BASE_MSRP)}
        </p>
        
        <div className="space-y-2 text-sm text-muted-foreground mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            {formatWeight(model.MAX_PAYLOAD_LBS)} payload
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {formatWeight(model.MAX_TOWING_LBS)} towing
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-500" />
            {model.SLEEPER_AVAILABLE ? "Sleeper available" : "Day cab only"}
          </div>
        </div>
        
        <button className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium flex items-center justify-center gap-2 group-hover:bg-primary/90 transition-colors">
          Configure
          <ChevronRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
        </button>
      </div>
    </div>
  );
}

function FindModelModal({ models, onClose, onSelectModel }: { 
  models: Model[]; 
  onClose: () => void; 
  onSelectModel: (model: Model) => void;
}) {
  const [step, setStep] = useState(1);
  const [priority, setPriority] = useState<string>("");
  const [hauling, setHauling] = useState<string>("");
  const [sleeper, setSleeper] = useState<string>("");
  const [budget, setBudget] = useState<string>("");
  const [showResult, setShowResult] = useState(false);

  const totalSteps = 4;
  const currentStep = priority ? (hauling ? (sleeper ? (budget ? 4 : 3) : 2) : 1) : 0;
  const progress = (currentStep / totalSteps) * 100;

  function getRecommendation(): { model: Model; score: number; reasons: string[] } | null {
    let scores: Record<string, { score: number; reasons: string[] }> = {};
    
    for (const model of models) {
      scores[model.MODEL_ID] = { score: 0, reasons: [] };
      
      if (priority === "power") {
        if (model.MODEL_ID === "MDL-HEAVYHAUL") {
          scores[model.MODEL_ID].score += 3;
          scores[model.MODEL_ID].reasons.push("Best-in-class power for demanding jobs");
        }
        if (model.MODEL_ID === "MDL-PREMIUM") {
          scores[model.MODEL_ID].score += 2;
          scores[model.MODEL_ID].reasons.push("Premium power with luxury features");
        }
      }
      if (priority === "economy") {
        if (model.MODEL_ID === "MDL-FLEET") {
          scores[model.MODEL_ID].score += 3;
          scores[model.MODEL_ID].reasons.push("Optimized for fuel efficiency");
        }
        if (model.MODEL_ID === "MDL-REGIONAL") {
          scores[model.MODEL_ID].score += 2;
          scores[model.MODEL_ID].reasons.push("Excellent fuel economy for regional routes");
        }
      }
      if (priority === "comfort") {
        if (model.MODEL_ID === "MDL-PREMIUM") {
          scores[model.MODEL_ID].score += 3;
          scores[model.MODEL_ID].reasons.push("Top-tier comfort and amenities");
        }
        if (model.MODEL_ID === "MDL-LONGHAUL") {
          scores[model.MODEL_ID].score += 2;
          scores[model.MODEL_ID].reasons.push("Long-haul comfort features");
        }
      }
      
      if (hauling === "heavy" && model.MAX_TOWING_LBS > 80000) {
        scores[model.MODEL_ID].score += 3;
        scores[model.MODEL_ID].reasons.push(`Handles ${formatWeight(model.MAX_TOWING_LBS)} towing capacity`);
      }
      if (hauling === "medium" && model.MAX_TOWING_LBS > 50000 && model.MAX_TOWING_LBS <= 80000) {
        scores[model.MODEL_ID].score += 3;
        scores[model.MODEL_ID].reasons.push("Perfect for medium-duty hauling");
      }
      if (hauling === "light" && model.MAX_TOWING_LBS <= 50000) {
        scores[model.MODEL_ID].score += 3;
        scores[model.MODEL_ID].reasons.push("Ideal for lighter loads");
      }
      
      if (sleeper === "yes" && model.SLEEPER_AVAILABLE) {
        scores[model.MODEL_ID].score += 2;
        scores[model.MODEL_ID].reasons.push("Sleeper cab available");
      }
      if (sleeper === "no" && !model.SLEEPER_AVAILABLE) {
        scores[model.MODEL_ID].score += 1;
        scores[model.MODEL_ID].reasons.push("Day cab configuration");
      }
      
      if (budget === "low" && model.BASE_MSRP < 100000) {
        scores[model.MODEL_ID].score += 2;
        scores[model.MODEL_ID].reasons.push("Within budget range");
      }
      if (budget === "medium" && model.BASE_MSRP >= 100000 && model.BASE_MSRP < 140000) {
        scores[model.MODEL_ID].score += 2;
        scores[model.MODEL_ID].reasons.push("Within budget range");
      }
      if (budget === "high" && model.BASE_MSRP >= 140000) {
        scores[model.MODEL_ID].score += 2;
        scores[model.MODEL_ID].reasons.push("Premium features included");
      }
    }
    
    const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
    if (sorted[0][1].score > 0) {
      const model = models.find(m => m.MODEL_ID === sorted[0][0]);
      if (model) {
        const uniqueReasons = [...new Set(sorted[0][1].reasons)];
        return { model, score: sorted[0][1].score, reasons: uniqueReasons.slice(0, 3) };
      }
    }
    return null;
  }

  const recommendation = getRecommendation();
  const maxPossibleScore = 10;
  const matchPercentage = recommendation ? Math.round((recommendation.score / maxPossibleScore) * 100) : 0;

  const priorityOptions = [
    { value: "power", label: "Power", icon: Zap, description: "Maximum hauling capability" },
    { value: "economy", label: "Fuel Economy", icon: Fuel, description: "Save on operating costs" },
    { value: "comfort", label: "Comfort", icon: Armchair, description: "Driver-focused features" }
  ];

  const haulingOptions = [
    { value: "light", label: "Light", subLabel: "<50k lbs", icon: Weight },
    { value: "medium", label: "Medium", subLabel: "50k-80k lbs", icon: Weight },
    { value: "heavy", label: "Heavy", subLabel: "80k+ lbs", icon: Weight }
  ];

  const sleeperOptions = [
    { value: "yes", label: "Yes", description: "For long haul routes", icon: BedDouble },
    { value: "no", label: "No", description: "Day cab only", icon: Truck }
  ];

  const budgetOptions = [
    { value: "low", label: "Under $100k", icon: DollarSign },
    { value: "medium", label: "$100k-$140k", icon: DollarSign },
    { value: "high", label: "$140k+", icon: DollarSign }
  ];

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-background rounded-2xl p-6 w-full max-w-lg shadow-2xl border max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Find Your Perfect Model</h2>
              <p className="text-xs text-muted-foreground">Answer a few questions for a personalized recommendation</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-full transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-6">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>{currentStep} of {totalSteps} answered</span>
            <span>{Math.round(progress)}% complete</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-primary to-primary/70 transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="flex items-center gap-2 text-sm font-semibold mb-3">
              <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold">1</span>
              What's most important to you?
            </label>
            <div className="grid grid-cols-3 gap-2">
              {priorityOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setPriority(opt.value)}
                  className={`p-3 rounded-xl border-2 text-sm font-medium transition-all duration-200 flex flex-col items-center gap-1 ${
                    priority === opt.value 
                      ? "border-primary bg-primary/10 shadow-md scale-[1.02]" 
                      : "border-transparent bg-muted/50 hover:bg-muted hover:scale-[1.02]"
                  }`}
                >
                  <opt.icon className={`h-5 w-5 ${priority === opt.value ? "text-primary" : "text-muted-foreground"}`} />
                  <span>{opt.label}</span>
                  {priority === opt.value && <Check className="h-3 w-3 text-primary" />}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-semibold mb-3">
              <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold">2</span>
              Typical hauling weight?
            </label>
            <div className="grid grid-cols-3 gap-2">
              {haulingOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setHauling(opt.value)}
                  className={`p-3 rounded-xl border-2 text-sm font-medium transition-all duration-200 flex flex-col items-center gap-1 ${
                    hauling === opt.value 
                      ? "border-primary bg-primary/10 shadow-md scale-[1.02]" 
                      : "border-transparent bg-muted/50 hover:bg-muted hover:scale-[1.02]"
                  }`}
                >
                  <opt.icon className={`h-5 w-5 ${hauling === opt.value ? "text-primary" : "text-muted-foreground"}`} />
                  <span>{opt.label}</span>
                  <span className="text-xs text-muted-foreground">{opt.subLabel}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-semibold mb-3">
              <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold">3</span>
              Need a sleeper cab?
            </label>
            <div className="grid grid-cols-2 gap-2">
              {sleeperOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setSleeper(opt.value)}
                  className={`p-3 rounded-xl border-2 text-sm font-medium transition-all duration-200 flex items-center gap-3 ${
                    sleeper === opt.value 
                      ? "border-primary bg-primary/10 shadow-md scale-[1.02]" 
                      : "border-transparent bg-muted/50 hover:bg-muted hover:scale-[1.02]"
                  }`}
                >
                  <opt.icon className={`h-5 w-5 ${sleeper === opt.value ? "text-primary" : "text-muted-foreground"}`} />
                  <div className="text-left">
                    <div>{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-semibold mb-3">
              <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold">4</span>
              Budget range?
            </label>
            <div className="grid grid-cols-3 gap-2">
              {budgetOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setBudget(opt.value)}
                  className={`p-3 rounded-xl border-2 text-sm font-medium transition-all duration-200 flex flex-col items-center gap-1 ${
                    budget === opt.value 
                      ? "border-primary bg-primary/10 shadow-md scale-[1.02]" 
                      : "border-transparent bg-muted/50 hover:bg-muted hover:scale-[1.02]"
                  }`}
                >
                  <opt.icon className={`h-5 w-5 ${budget === opt.value ? "text-primary" : "text-muted-foreground"}`} />
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {recommendation && (
          <div className="mt-6 p-4 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 rounded-xl">
            <div className="flex items-start gap-4">
              <div className="relative">
                <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                  <Star className="h-8 w-8 text-primary" />
                </div>
                <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center shadow-lg">
                  {matchPercentage}%
                </div>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-primary mb-1">
                  <TrendingUp className="h-4 w-4" />
                  Best Match
                </div>
                <div className="text-lg font-bold">{recommendation.model.MODEL_NM}</div>
                <div className="text-sm text-muted-foreground mb-2">
                  Starting at {formatCurrency(recommendation.model.BASE_MSRP)}
                </div>
                <div className="space-y-1">
                  {recommendation.reasons.map((reason, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Check className="h-3 w-3 text-green-500 flex-shrink-0" />
                      <span>{reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 py-3 border rounded-xl font-medium hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => recommendation && onSelectModel(recommendation.model)}
            disabled={!recommendation}
            className="flex-1 py-3 bg-primary text-primary-foreground rounded-xl font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {recommendation ? (
              <>
                Configure {recommendation.model.MODEL_NM.split(" ").pop()}
                <ChevronRight className="h-4 w-4" />
              </>
            ) : (
              "Answer questions above"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
