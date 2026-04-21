"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import type { Model, BOMOption } from "@/app/page";
import { formatCurrency, formatWeight, cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, AlertTriangle, Lightbulb, Check, Save, Truck, ShieldCheck, MessageCircle, Send, X, Sparkles, Loader2, FileText, Upload, Trash2, Info, ExternalLink, CheckCircle2, XCircle, Search } from "lucide-react";

interface ConfiguratorProps {
  model: Model;
  selectedOptions: string[];
  setSelectedOptions: (options: string[]) => void;
  onSave: () => Promise<void>;
  onOptionsLoaded?: (options: BOMOption[]) => void;
  loadedConfigName?: string | null;
  onConfigNameChange?: (name: string | null) => void;
  onClearConfig?: () => void;
  sessionId?: string;
}

type Hierarchy = Record<string, {
  subsystems: Record<string, {
    componentGroups: Record<string, BOMOption[]>
  }>
}>;

interface ValidationResult {
  issues: { 
    type: string; 
    title: string; 
    message: string; 
    relatedOptions: string[]; 
    sourceDoc?: string;
    specMismatches?: Array<{ specName: string; currentValue: number | null; requiredValue: number | null; reason: string }>;
  }[];
  suggestions: { title: string; message: string; relatedOptions: string[]; suggestedOptions?: string[] }[];
  fixPlan?: { remove: string[]; add: string[]; explanation: string };
}

export function Configurator({ model, selectedOptions, setSelectedOptions, onSave, onOptionsLoaded, loadedConfigName, onConfigNameChange, onClearConfig, sessionId }: ConfiguratorProps) {
  const [hierarchy, setHierarchy] = useState<Hierarchy>({});
  const [allOptions, setAllOptions] = useState<BOMOption[]>([]);
  const [defaultOptions, setDefaultOptions] = useState<string[]>([]);
  const [activeSystem, setActiveSystem] = useState<string>("");
  const [activeSubsystem, setActiveSubsystem] = useState<string>("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [validation, setValidation] = useState<ValidationResult>({ issues: [], suggestions: [] });
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [hoveredSpecOption, setHoveredSpecOption] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [defaultScores, setDefaultScores] = useState<Record<string, number>>({});
  const [isValidated, setIsValidated] = useState(false);
  const [lastValidatedOptions, setLastValidatedOptions] = useState<string[]>([]);
  const [engineeringDocs, setEngineeringDocs] = useState<Array<{docId: string; docTitle: string; docPath: string; chunkCount: number; linkedParts: Array<{optionId: string; optionName: string; componentGroup: string}>}>>([]);
  const [showEngDocs, setShowEngDocs] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<Record<string, {status: string; message?: string}>>({});
  const [deleteProgress, setDeleteProgress] = useState<{docId: string; steps: Record<string, {status: string; message?: string}>} | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{docId: string; docTitle: string} | null>(null);
  const [uploadModal, setUploadModal] = useState<{fileName: string; optionId?: string; optionName?: string; steps: Record<string, {status: string; message?: string}>; error?: string; success?: boolean} | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const chatSessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Track optimization history and manual changes for AI description
  const [optimizationHistory, setOptimizationHistory] = useState<string[]>([]);
  const [manualChanges, setManualChanges] = useState<string[]>([]);
  
  // Track loadedConfigName in a ref for use in async functions
  const loadedConfigNameRef = useRef(loadedConfigName);
  loadedConfigNameRef.current = loadedConfigName;

  useEffect(() => {
    loadOptions();
    loadEngineeringDocs();
  }, [model.MODEL_ID]);

  async function loadEngineeringDocs() {
    try {
      const res = await fetch("/api/engineering-docs");
      if (res.ok) {
        const data = await res.json();
        setEngineeringDocs(data.docs || []);
      }
    } catch (error) {
      console.error("Failed to load engineering docs:", error);
    }
  }

  async function handleDocUpload(e: React.ChangeEvent<HTMLInputElement>, targetOptionId?: string) {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const targetOption = targetOptionId ? allOptions.find(o => o.OPTION_ID === targetOptionId) : undefined;
    const initialSteps: Record<string, {status: string; message?: string}> = targetOptionId 
      ? { upload: { status: 'pending' }, extract: { status: 'pending' }, rules: { status: 'pending' } }
      : { upload: { status: 'pending' }, extract: { status: 'pending' }, detect: { status: 'pending' } };
    
    setUploadModal({
      fileName: file.name,
      optionId: targetOptionId,
      optionName: targetOption?.OPTION_NM,
      steps: initialSteps
    });
    
    if (!targetOptionId) {
      setUploadingDoc(true);
      setUploadWarning(null);
      setUploadProgress(initialSteps);
    }
    
    try {
      const formData = new FormData();
      formData.append("file", file);
      
      // Python backend expects linkedParts as JSON array
      if (targetOptionId && targetOption) {
        const linkedParts = [{
          optionId: targetOptionId,
          optionName: targetOption.OPTION_NM,
          componentGroup: targetOption.COMPONENT_GROUP
        }];
        formData.append("linkedParts", JSON.stringify(linkedParts));
      } else {
        formData.append("linkedParts", "[]");
      }
      
      const timeout = setTimeout(() => {
        console.warn("Upload operation timed out");
        setUploadModal(prev => prev ? { ...prev, error: "Upload timed out" } : null);
        if (!targetOptionId) {
          setUploadWarning("Upload timed out");
          setUploadingDoc(false);
        }
        loadEngineeringDocs();
      }, 120000);
      
      const res = await fetch("/api/engineering-docs/upload", {
        method: "POST",
        body: formData
      });
      
      // Both Python and Next.js backends now use SSE streaming
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      
      if (reader) {
        let buffer = '';
        let gotResult = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'result') {
                  gotResult = true;
                  clearTimeout(timeout);
                  if (data.success) {
                    if (!targetOptionId && data.warning) setUploadWarning(data.warning);
                    await loadEngineeringDocs();
                    if (data.rulesCreated > 0) {
                      validateConfig();
                    }
                    setUploadModal(prev => prev ? { ...prev, success: true } : null);
                    setTimeout(() => setUploadModal(null), 1500);
                    if (!targetOptionId) {
                      setUploadingDoc(false);
                      setUploadProgress({});
                    }
                  } else {
                    setUploadModal(prev => prev ? { ...prev, error: data.error || "Upload failed" } : null);
                    if (!targetOptionId) {
                      setUploadWarning(data.error || "Upload failed");
                      setUploadingDoc(false);
                    }
                  }
                } else if (data.step) {
                  // Real progress update from backend
                  setUploadModal(prev => prev ? {
                    ...prev,
                    steps: { ...prev.steps, [data.step]: { status: data.status, message: data.message } }
                  } : null);
                  if (!targetOptionId) {
                    setUploadProgress(prev => ({
                      ...prev,
                      [data.step]: { status: data.status, message: data.message }
                    }));
                  }
                }
              } catch (parseErr) {
                console.warn("Failed to parse SSE data:", parseErr);
              }
            }
          }
        }
        if (!gotResult) {
          clearTimeout(timeout);
          await loadEngineeringDocs();
          setUploadModal(prev => prev ? { ...prev, success: true } : null);
          setTimeout(() => setUploadModal(null), 1500);
          if (!targetOptionId) {
            setUploadingDoc(false);
            setUploadProgress({});
          }
        }
      } else {
        clearTimeout(timeout);
      }
    } catch (error) {
      console.error("Upload error:", error);
      setUploadModal(prev => prev ? { ...prev, error: "Upload failed - please try again" } : null);
      if (!targetOptionId) {
        setUploadWarning("Failed to upload document - please try again");
        setUploadingDoc(false);
      }
    } finally {
      e.target.value = "";
    }
  }

  async function handleDeleteDoc(docId: string, docTitle: string) {
    setDeleteConfirm(null);
    setDeleteProgress({
      docId,
      steps: {
        lookup: { status: 'pending' },
        delete_chunks: { status: 'pending' },
        delete_stage: { status: 'pending' }
      }
    });
    
    const timeout = setTimeout(() => {
      console.warn("Delete operation timed out");
      setDeleteProgress(null);
      loadEngineeringDocs();
    }, 30000);
    
    try {
      const res = await fetch("/api/engineering-docs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId })
      });
      
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      
      if (reader) {
        let buffer = '';
        let gotResult = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'result') {
                  gotResult = true;
                  clearTimeout(timeout);
                  if (data.success) {
                    await loadEngineeringDocs();
                    validateConfig();
                    setTimeout(() => setDeleteProgress(null), 1500);
                  } else {
                    console.error("Delete failed:", data.error);
                    setTimeout(() => setDeleteProgress(null), 3000);
                  }
                } else {
                  setDeleteProgress(prev => prev ? {
                    ...prev,
                    steps: {
                      ...prev.steps,
                      [data.step]: { status: data.status, message: data.message }
                    }
                  } : null);
                }
              } catch (parseErr) {
                console.warn("Failed to parse SSE data:", parseErr);
              }
            }
          }
        }
        if (!gotResult) {
          clearTimeout(timeout);
          await loadEngineeringDocs();
          validateConfig();
          setTimeout(() => setDeleteProgress(null), 1500);
        }
      } else {
        clearTimeout(timeout);
        setDeleteProgress(null);
      }
    } catch (error) {
      console.error("Failed to delete doc:", error);
      clearTimeout(timeout);
      setDeleteProgress(null);
    }
  }

  const partsWithDocs = useMemo(() => {
    const partMap = new Map<string, { docId: string; docTitle: string; chunkCount: number }>();
    for (const doc of engineeringDocs) {
      for (const part of doc.linkedParts) {
        partMap.set(part.optionId, { docId: doc.docId, docTitle: doc.docTitle, chunkCount: doc.chunkCount });
      }
    }
    return partMap;
  }, [engineeringDocs]);

  const anySelectedPartHasDoc = useMemo(() => {
    return selectedOptions.some(optId => partsWithDocs.has(optId));
  }, [selectedOptions, partsWithDocs]);

  function formatSpecLabel(key: string): string {
    const labels: Record<string, string> = {
      hp: 'Horsepower',
      torque_lb_ft: 'Torque',
      boost_psi: 'Boost Pressure',
      cooling_capacity_hp: 'Cooling Capacity',
      max_ambient_temp_f: 'Max Ambient Temp',
      weight_rating_lbs: 'Weight Rating',
      gear_count: 'Gears',
      torque_capacity_lb_ft: 'Torque Capacity',
      type: 'Type',
      max_supported_hp: 'Max Supported HP',
      adds_cooling_requirement_hp: 'Additional Cooling Req',
      requires_cooling_hp: 'Requires Cooling',
      requires_front_axle_lbs: 'Requires Front Axle',
      requires_torque_capacity: 'Requires Torque Capacity',
    };
    return labels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  function formatSpecValue(key: string, value: unknown): string {
    if (typeof value === 'number') {
      if (key.includes('hp') || key.includes('HP')) return `${value.toLocaleString()} HP`;
      if (key.includes('torque') || key.includes('lb_ft')) return `${value.toLocaleString()} lb-ft`;
      if (key.includes('psi')) return `${value} PSI`;
      if (key.includes('lbs') || key.includes('axle')) return `${value.toLocaleString()} lbs`;
      if (key.includes('temp')) return `${value}°F`;
      if (key === 'gear_count') return `${value}-speed`;
      return value.toLocaleString();
    }
    if (typeof value === 'string') {
      return value.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }
    return String(value);
  }

  // Re-apply loaded configuration after defaults are loaded
  useEffect(() => {
    // This re-applies loaded config options that may have been overridden by defaults
    if (loadedConfigName && allOptions.length > 0) {
      // Find the config that matches the loaded name from parent component
      // Note: This requires access to saved configs, which we don't have here
      // The parent component should handle this by re-setting options after model loads
    }
  }, [loadedConfigName, allOptions]);

  useEffect(() => {
    if (isValidated && lastValidatedOptions.length > 0) {
      const optionsChanged = selectedOptions.length !== lastValidatedOptions.length ||
        selectedOptions.some(id => !lastValidatedOptions.includes(id));
      if (optionsChanged) {
        setIsValidated(false);
      }
    }
  }, [selectedOptions, isValidated, lastValidatedOptions]);

  // Removed auto-validation on selection change - validation is now only triggered by Verify button

  async function loadOptions() {
    try {
      const res = await fetch(`/api/options?modelId=${model.MODEL_ID}`);
      const data = await res.json();
      setHierarchy(data.hierarchy);
      setAllOptions(data.options);
      onOptionsLoaded?.(data.options);
      
      const defaults = data.modelOptions
        .filter((mo: { IS_DEFAULT: boolean }) => mo.IS_DEFAULT)
        .map((mo: { OPTION_ID: string }) => mo.OPTION_ID);
      setDefaultOptions(defaults);
      // Only set defaults if we're NOT loading a saved config (check ref for current value)
      if (!loadedConfigNameRef.current) {
        setSelectedOptions(defaults);
      }
      
      const defaultPerformance = calculateScores(defaults, data.options);
      setDefaultScores(defaultPerformance);
      
      const systems = Object.keys(data.hierarchy);
      if (systems.length > 0) {
        setActiveSystem(systems[0]);
        const subsystems = Object.keys(data.hierarchy[systems[0]].subsystems);
        if (subsystems.length > 0) {
          setActiveSubsystem(subsystems[0]);
        }
      }
    } catch (err) {
      console.error("Error loading options:", err);
    }
  }

  function calculateScores(optionIds: string[], options: BOMOption[]): Record<string, number> {
    const scores: Record<string, number[]> = {};
    for (const optId of optionIds) {
      const opt = options.find(o => o.OPTION_ID === optId);
      if (opt) {
        if (!scores[opt.PERFORMANCE_CATEGORY]) {
          scores[opt.PERFORMANCE_CATEGORY] = [];
        }
        scores[opt.PERFORMANCE_CATEGORY].push(opt.PERFORMANCE_SCORE);
      }
    }
    const avgScores: Record<string, number> = {};
    for (const [cat, vals] of Object.entries(scores)) {
      avgScores[cat] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return avgScores;
  }

  async function validateConfig(incrementalOnly?: string[], updatedOptions?: string[]) {
    setValidating(true);
    const optionsToValidate = updatedOptions || selectedOptions;
    try {
      const res = await fetch("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          selectedOptions: optionsToValidate, 
          modelId: model.MODEL_ID,
          incrementalOnly // Only validate these new options (if provided)
        }),
      });
      const data = await res.json();
      setValidation({
        issues: data.issues || [],
        suggestions: data.suggestions || [],
        fixPlan: data.fixPlan
      });
      if ((data.issues || []).length === 0) {
        setIsValidated(true);
        setLastValidatedOptions([...optionsToValidate]);
      } else {
        setIsValidated(false);
      }
    } catch (err) {
      console.error("Error validating:", err);
      setValidation({ issues: [], suggestions: [] });
      setIsValidated(false);
    } finally {
      setValidating(false);
    }
  }

  const { totalCost, totalWeight, performanceScores, optionsCost } = useMemo(() => {
    let cost = model.BASE_MSRP;
    let weight = model.BASE_WEIGHT_LBS;
    let optsCost = 0;
    const scores = calculateScores(selectedOptions, allOptions);
    
    for (const optId of selectedOptions) {
      const opt = allOptions.find(o => o.OPTION_ID === optId);
      if (opt) {
        cost += opt.COST_USD;
        weight += opt.WEIGHT_LBS;
        optsCost += opt.COST_USD;
      }
    }

    return { totalCost: cost, totalWeight: weight, performanceScores: scores, optionsCost: optsCost };
  }, [selectedOptions, allOptions, model]);

  function toggleOption(optionId: string, componentGroup: string) {
    const groupOptions = allOptions.filter(o => 
      o.COMPONENT_GROUP === componentGroup && 
      o.SUBSYSTEM_NM === activeSubsystem &&
      o.SYSTEM_NM === activeSystem
    );
    const groupOptionIds = groupOptions.map(o => o.OPTION_ID);
    const currentlySelected = selectedOptions.find(id => groupOptionIds.includes(id));
    const withoutGroup = selectedOptions.filter(id => !groupOptionIds.includes(id));
    
    // Get option details for tracking manual changes
    const newOption = allOptions.find(o => o.OPTION_ID === optionId);
    const oldOption = currentlySelected ? allOptions.find(o => o.OPTION_ID === currentlySelected) : null;
    
    if (currentlySelected === optionId) {
      const hasZeroCostOption = groupOptions.some(o => o.COST_USD === 0);
      if (hasZeroCostOption) {
        const zeroCostOption = groupOptions.find(o => o.COST_USD === 0);
        if (zeroCostOption && zeroCostOption.OPTION_ID !== optionId) {
          setSelectedOptions([...withoutGroup, zeroCostOption.OPTION_ID]);
          // Track as manual change: downgraded to base
          if (newOption) {
            setManualChanges(prev => [...prev, `Reverted ${componentGroup} to base option`]);
          }
        } else {
          setSelectedOptions(withoutGroup);
        }
      } else {
        setSelectedOptions(withoutGroup);
      }
    } else {
      setSelectedOptions([...withoutGroup, optionId]);
      // Track as manual change
      if (newOption) {
        const changeDesc = oldOption 
          ? `Changed ${componentGroup}: ${oldOption.OPTION_NM} → ${newOption.OPTION_NM}`
          : `Added ${newOption.OPTION_NM} (${componentGroup})`;
        setManualChanges(prev => [...prev, changeDesc]);
      }
    }
  }

  function handleSystemChange(system: string) {
    setActiveSystem(system);
    const subsystems = Object.keys(hierarchy[system]?.subsystems || {});
    if (subsystems.length > 0) {
      setActiveSubsystem(subsystems[0]);
    }
  }

  const systems = Object.keys(hierarchy);
  const subsystems = Object.keys(hierarchy[activeSystem]?.subsystems || {});
  const componentGroups = hierarchy[activeSystem]?.subsystems[activeSubsystem]?.componentGroups || {};

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const query = searchQuery.toLowerCase();
    return allOptions.filter(o => 
      o.OPTION_NM.toLowerCase().includes(query) ||
      o.COMPONENT_GROUP.toLowerCase().includes(query) ||
      o.SUBSYSTEM_NM.toLowerCase().includes(query) ||
      o.SYSTEM_NM.toLowerCase().includes(query) ||
      o.DESCRIPTION?.toLowerCase().includes(query)
    ).slice(0, 20);
  }, [searchQuery, allOptions]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (searchQuery) {
          setSearchQuery("");
        } else if (showSaveModal) {
          setShowSaveModal(false);
        } else if (showVerifyModal) {
          setShowVerifyModal(false);
        } else if (showChat) {
          setShowChat(false);
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        setShowSaveModal(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery, showSaveModal, showVerifyModal, showChat]);

  function selectSearchResult(option: BOMOption) {
    const groupOptions = allOptions.filter(o => 
      o.COMPONENT_GROUP === option.COMPONENT_GROUP && 
      o.SUBSYSTEM_NM === option.SUBSYSTEM_NM &&
      o.SYSTEM_NM === option.SYSTEM_NM
    );
    const groupOptionIds = groupOptions.map(o => o.OPTION_ID);
    const withoutGroup = selectedOptions.filter(id => !groupOptionIds.includes(id));
    setSelectedOptions([...withoutGroup, option.OPTION_ID]);
    setSearchQuery("");
    setActiveSystem(option.SYSTEM_NM);
    setActiveSubsystem(option.SUBSYSTEM_NM);
  }

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      <div className="flex-1 overflow-auto p-6">
        <div className="relative mb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search options... (Ctrl+K or /)"
              className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-muted rounded"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
          </div>
          {searchResults && searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-background border rounded-lg shadow-lg z-50 max-h-80 overflow-auto">
              {searchResults.map(option => {
                const isSelected = selectedOptions.includes(option.OPTION_ID);
                return (
                  <button
                    key={option.OPTION_ID}
                    onClick={() => selectSearchResult(option)}
                    className={cn(
                      "w-full text-left px-4 py-3 hover:bg-muted border-b last:border-b-0 transition-colors",
                      isSelected && "bg-primary/5"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{option.OPTION_NM}</span>
                      <span className={cn(
                        "text-sm",
                        option.COST_USD === 0 ? "text-green-600" : "text-muted-foreground"
                      )}>
                        {option.COST_USD === 0 ? "Included" : `+${formatCurrency(option.COST_USD)}`}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {option.SYSTEM_NM} → {option.SUBSYSTEM_NM} → {option.COMPONENT_GROUP}
                    </div>
                    {isSelected && (
                      <span className="inline-flex items-center gap-1 mt-1 text-xs text-primary">
                        <Check className="h-3 w-3" /> Selected
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {searchResults && searchResults.length === 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-background border rounded-lg shadow-lg z-50 p-4 text-center text-muted-foreground text-sm">
              No options found for "{searchQuery}"
            </div>
          )}
        </div>
        <div className="flex gap-2 mb-6 flex-wrap">
          {systems.map(system => (
            <button
              key={system}
              onClick={() => handleSystemChange(system)}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                activeSystem === system
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted hover:bg-muted/80"
              )}
            >
              {system}
              {selectedOptions.some(id => allOptions.find(o => o.OPTION_ID === id && o.SYSTEM_NM === system)) && (
                <Check className="inline-block ml-1 h-3 w-3" />
              )}
            </button>
          ))}
        </div>

        <div className="flex gap-6">
          <div className="w-48 shrink-0">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {activeSystem}
            </h3>
            <nav className="space-y-1">
              {subsystems.map(subsystem => (
                <button
                  key={subsystem}
                  onClick={() => setActiveSubsystem(subsystem)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2",
                    activeSubsystem === subsystem
                      ? "bg-primary/10 text-primary font-medium"
                      : "hover:bg-muted"
                  )}
                >
                  {activeSubsystem === subsystem ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  {subsystem}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1 space-y-6">
            <div className="text-sm text-muted-foreground">
              {activeSystem} → {activeSubsystem}
            </div>
            
            {Object.entries(componentGroups).map(([groupName, options]) => (
              <div key={groupName} className="border rounded-lg overflow-visible">
                <button
                  onClick={() => {
                    const newExpanded = new Set(expandedGroups);
                    if (newExpanded.has(groupName)) {
                      newExpanded.delete(groupName);
                    } else {
                      newExpanded.add(groupName);
                    }
                    setExpandedGroups(newExpanded);
                  }}
                  className="w-full px-4 py-3 bg-muted/50 flex items-center justify-between hover:bg-muted transition-colors"
                >
                  <span className="font-medium">{groupName}</span>
                  <ChevronDown className={cn(
                    "h-5 w-5 transition-transform",
                    expandedGroups.has(groupName) ? "rotate-180" : ""
                  )} />
                </button>
                
                {(expandedGroups.has(groupName) || expandedGroups.size === 0) && (
                  <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {options.map(option => {
                      const isSelected = selectedOptions.includes(option.OPTION_ID);
                      const isDefault = defaultOptions.includes(option.OPTION_ID);
                      // Check if this is the currently selected option for this component group
                      const selectedInGroup = selectedOptions.find(id => 
                        options.some(o => o.OPTION_ID === id)
                      );
                      const isActiveSelection = option.OPTION_ID === selectedInGroup;
                      
                      return (
                        <button
                          key={option.OPTION_ID}
                          onClick={() => toggleOption(option.OPTION_ID, groupName)}
                          className={cn(
                            "p-4 rounded-lg border-2 text-left transition-all duration-200",
                            isActiveSelection
                              ? "border-primary bg-primary/5 scale-[1.02] shadow-md"
                              : "border-transparent bg-muted/30 hover:bg-muted/50 hover:scale-[1.01]"
                          )}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{option.OPTION_NM}</span>
                              {partsWithDocs.has(option.OPTION_ID) && (() => {
                                const docInfo = partsWithDocs.get(option.OPTION_ID)!;
                                return (
                                  <div className="relative group/doc flex items-center gap-1">
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        try {
                                          const res = await fetch(`/api/engineering-docs/view?docId=${encodeURIComponent(docInfo.docId)}`);
                                          const data = await res.json();
                                          if (data.url) {
                                            window.open(data.url, '_blank');
                                          } else {
                                            alert('Could not load document');
                                          }
                                        } catch {
                                          alert('Error loading document');
                                        }
                                      }}
                                      onKeyDown={async (e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.stopPropagation();
                                          e.preventDefault();
                                          try {
                                            const res = await fetch(`/api/engineering-docs/view?docId=${encodeURIComponent(docInfo.docId)}`);
                                            const data = await res.json();
                                            if (data.url) {
                                              window.open(data.url, '_blank');
                                            }
                                          } catch {}
                                        }
                                      }}
                                      className="flex items-center gap-0.5 hover:bg-blue-100 rounded p-0.5 transition-colors cursor-pointer"
                                    >
                                      <FileText className="h-3.5 w-3.5 text-blue-500" />
                                      <ExternalLink className="h-2.5 w-2.5 text-blue-400" />
                                    </span>
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        setDeleteConfirm({ docId: docInfo.docId, docTitle: docInfo.docTitle });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.stopPropagation();
                                          e.preventDefault();
                                          setDeleteConfirm({ docId: docInfo.docId, docTitle: docInfo.docTitle });
                                        }
                                      }}
                                      className="p-0.5 hover:bg-red-100 rounded transition-all cursor-pointer"
                                      title="Delete document"
                                    >
                                      <Trash2 className="h-3 w-3 text-red-400 hover:text-red-600" />
                                    </span>
                                    <div className="absolute left-0 top-6 z-50 hidden group-hover/doc:block">
                                      <div className="bg-slate-800 text-white text-xs rounded-lg shadow-lg p-3 min-w-[180px] max-w-[260px]">
                                        <div className="font-semibold mb-1.5 text-blue-300 flex items-center gap-1">
                                          <FileText className="h-3 w-3" />
                                          Engineering Spec
                                        </div>
                                        <div className="text-slate-300 mb-2 line-clamp-2">{docInfo.docTitle}</div>
                                        <div className="flex items-center gap-2 text-green-400">
                                          <Check className="h-3 w-3" />
                                          <span>Indexed ({docInfo.chunkCount} chunks)</span>
                                        </div>
                                        <div className="mt-2 pt-2 border-t border-slate-600 text-slate-400 text-[10px]">
                                          Click icon to view PDF | Hover for delete
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}
                              {option.SPECS && Object.keys(option.SPECS).length > 0 && (
                                <div 
                                  className="relative inline-block"
                                  onMouseEnter={() => setHoveredSpecOption(option.OPTION_ID)}
                                  onMouseLeave={() => setHoveredSpecOption(null)}
                                >
                                  <Info className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600 cursor-help" />
                                  <div className={cn(
                                    "absolute right-0 top-6 z-[100] transition-opacity duration-150",
                                    hoveredSpecOption === option.OPTION_ID ? "visible opacity-100" : "invisible opacity-0"
                                  )}>
                                    <div className="bg-slate-800 text-white text-xs rounded-lg shadow-xl p-3 w-[260px] border border-slate-700">
                                      <div className="font-semibold mb-2 text-slate-200">Technical Specs</div>
                                      <div className="space-y-1.5">
                                        {Object.entries(option.SPECS).map(([key, value]) => (
                                          <div key={key} className="flex justify-between gap-2">
                                            <span className="text-slate-400 shrink-0">{formatSpecLabel(key)}:</span>
                                            <span className="font-medium text-right break-words">{formatSpecValue(key, value)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                              {!partsWithDocs.has(option.OPTION_ID) && isActiveSelection && (
                                <label
                                    htmlFor={`upload-${option.OPTION_ID}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                    }}
                                    className="flex items-center gap-0.5 hover:bg-blue-100 rounded p-0.5 transition-colors cursor-pointer"
                                    title="Upload engineering spec for this part"
                                  >
                                    <Upload className="h-3 w-3 text-slate-400 hover:text-blue-500" />
                                    <input
                                      id={`upload-${option.OPTION_ID}`}
                                      type="file"
                                      accept=".pdf"
                                      className="hidden"
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => handleDocUpload(e, option.OPTION_ID)}
                                    />
                                  </label>
                              )}
                            </div>
                            {isActiveSelection && <Check className="h-5 w-5 text-primary shrink-0" />}
                          </div>
                          <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
                            {option.DESCRIPTION}
                          </p>
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between text-sm">
                              <span className={cn(
                                "font-semibold",
                                option.COST_USD === 0 ? "text-green-600" : "text-foreground"
                              )}>
                                {option.COST_USD === 0 ? "Included" : `+${formatCurrency(option.COST_USD)}`}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {formatWeight(option.WEIGHT_LBS)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              {isDefault && (
                                <span className="text-xs bg-muted px-2 py-0.5 rounded">Default</span>
                              )}
                            </div>
                            <span className={cn(
                              "text-xs px-1.5 py-0.5 rounded",
                              option.PERFORMANCE_CATEGORY === 'Efficiency' ? "bg-green-100 text-green-700" :
                              option.PERFORMANCE_CATEGORY === 'Safety' ? "bg-blue-100 text-blue-700" :
                              option.PERFORMANCE_CATEGORY === 'Comfort' ? "bg-purple-100 text-purple-700" :
                              option.PERFORMANCE_CATEGORY === 'Economy' ? "bg-amber-100 text-amber-700" :
                              "bg-gray-100 text-gray-700"
                            )}>
                              {option.PERFORMANCE_CATEGORY} {(() => {
                                const fullStars = Math.floor(option.PERFORMANCE_SCORE);
                                const halfStar = option.PERFORMANCE_SCORE % 1 >= 0.5;
                                const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
                                return (
                                  <>
                                    {'★'.repeat(fullStars)}
                                    {halfStar && <span style={{position: 'relative', display: 'inline-block'}}><span style={{color: 'inherit'}}>☆</span><span style={{position: 'absolute', left: 0, overflow: 'hidden', width: '50%'}}>★</span></span>}
                                    {'☆'.repeat(emptyStars)}
                                  </>
                                );
                              })()}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <aside className="w-80 border-l bg-muted/30 p-6 overflow-auto">
        <div className="space-y-6">
          <div className="text-center pb-6 border-b">
            <div className="w-40 h-28 mx-auto mb-4 rounded-xl overflow-hidden bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center">
              <img 
                src={`/${model.MODEL_ID}.png`} 
                alt={model.MODEL_NM}
                className="w-full h-full object-contain"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </div>
            <h2 className="text-xl font-bold">{model.MODEL_NM}</h2>
            {loadedConfigName && (
              <div className="mt-2 inline-flex items-center gap-2 px-3 py-1 bg-primary/10 text-primary rounded-full text-sm">
                <span className="font-medium">{loadedConfigName}</span>
                <button
                  onClick={() => {
                    onConfigNameChange?.(null);
                    // Reset to default options
                    setSelectedOptions(defaultOptions);
                  }}
                  className="hover:bg-primary/20 rounded-full p-0.5"
                  title="Clear loaded config"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="text-sm text-muted-foreground mb-1">Total Price</div>
            <div className="flex items-center gap-2">
              <div className="text-3xl font-bold">{formatCurrency(totalCost)}</div>
              {isValidated && (
                <div className="flex items-center gap-1 px-2 py-1 bg-green-100 rounded-full" title="Configuration validated">
                  <ShieldCheck className="h-4 w-4 text-green-600" />
                  <span className="text-xs font-medium text-green-600">Valid</span>
                </div>
              )}
            </div>
            <div className="text-sm text-muted-foreground space-y-0.5 mt-1">
              <div>Base MSRP: {formatCurrency(model.BASE_MSRP)}</div>
              <div>Options: {formatCurrency(optionsCost)}</div>
            </div>
          </div>

          <div>
            <div className="text-sm text-muted-foreground mb-1">Total Weight</div>
            <div className="text-xl font-semibold">{formatWeight(totalWeight)}</div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-3">
              <span className="text-sm text-muted-foreground">Performance</span>
              <span className="text-xs text-muted-foreground">| = default</span>
            </div>
            <div className="space-y-3">
              {["Safety", "Comfort", "Power", "Economy", "Durability", "Hauling", "Cooling", "Emissions"].map((category) => {
                const score = performanceScores[category] || 0;
                const defaultScore = defaultScores[category] || 0;
                const pct = Math.round(score * 20);
                const defaultPct = Math.round(defaultScore * 20);
                const isUpgraded = score > defaultScore && defaultScore > 0;
                const isDowngraded = score < defaultScore && score > 0;
                const hasData = score > 0 || defaultScore > 0;
                const showCurrentBar = score > 0;
                
                return (
                  <div key={category}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className={!hasData ? "text-muted-foreground/50" : ""}>{category}</span>
                      <span className={cn(
                        !hasData && "text-muted-foreground/50",
                        isUpgraded && "text-green-600 font-medium",
                        isDowngraded && "text-red-500 font-medium"
                      )}>
                        {showCurrentBar ? `${pct}%` : defaultScore > 0 ? `(${defaultPct}%)` : "—"}
                        {isUpgraded && " ↑"}
                        {isDowngraded && " ↓"}
                      </span>
                    </div>
                    <div className="relative h-3 bg-muted rounded-full overflow-hidden">
                      {showCurrentBar && (
                        <div 
                          className={cn(
                            "h-full rounded-full transition-all",
                            isUpgraded ? "bg-green-500" : isDowngraded ? "bg-red-400" : "bg-primary"
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      )}
                      {defaultScore > 0 && (
                        <div 
                          className="absolute top-0 bottom-0 w-1 bg-foreground/80 z-10"
                          style={{ left: `calc(${defaultPct}% - 2px)` }}
                          title={`Default: ${defaultPct}%`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {validation.issues.length > 0 && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
              <div className="flex items-center gap-2 text-destructive font-medium mb-2">
                <AlertTriangle className="h-4 w-4" />
                {validation.issues.length} Issue{validation.issues.length > 1 ? "s" : ""} Found
              </div>
              {validation.issues.map((issue, i) => (
                <p key={i} className="text-sm text-muted-foreground">{issue.message}</p>
              ))}
            </div>
          )}

          {validation.suggestions.length > 0 && (
            <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-amber-600 font-medium mb-2">
                <Lightbulb className="h-4 w-4" />
                Suggestion
              </div>
              {validation.suggestions.map((sug, i) => (
                <p key={i} className="text-sm text-muted-foreground">{sug.message}</p>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <div className="relative group/verify">
              <button
                onClick={async () => {
                  await validateConfig();
                  setShowVerifyModal(true);
                }}
                disabled={validating || !anySelectedPartHasDoc}
                className={cn(
                  "w-full py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors",
                  !anySelectedPartHasDoc
                    ? "bg-muted text-muted-foreground cursor-not-allowed"
                    : validating
                      ? "bg-muted text-muted-foreground cursor-wait"
                      : validation.issues.length === 0 
                        ? "bg-green-600 text-white hover:bg-green-700"
                        : "bg-amber-500 text-white hover:bg-amber-600"
                )}
              >
                {validating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Analyzing Configuration...
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-4 w-4" />
                    Verify Configuration
                  </>
                )}
              </button>
              {!anySelectedPartHasDoc && (
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-slate-800 text-white text-xs rounded-lg shadow-lg opacity-0 group-hover/verify:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                  Upload an engineering spec to a selected part to enable verification
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
                </div>
              )}
            </div>
            
            <button
              onClick={() => setShowSaveModal(true)}
              className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium flex items-center justify-center gap-2 hover:bg-primary/90 transition-colors"
            >
              <Save className="h-4 w-4" />
              Save Configuration
            </button>
          </div>
        </div>
      </aside>

      <button
        onClick={() => setShowChat(!showChat)}
        className={cn(
          "fixed bottom-6 right-6 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all z-40",
          showChat ? "bg-muted" : "bg-primary text-primary-foreground hover:bg-primary/90"
        )}
      >
        {showChat ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
      </button>

      {showChat && (
        <ChatPanel 
          model={model}
          selectedOptions={selectedOptions}
          allOptions={allOptions}
          sessionId={chatSessionId}
          onClose={() => setShowChat(false)}
          onApplyOptions={(optionIds, replaceAll, optimizationRequest) => {
            console.log("=== APPLY OPTIONS CALLED ===");
            console.log("Option IDs received:", optionIds.length, "replaceAll:", replaceAll);
            console.log("Optimization request:", optimizationRequest);
            
            // Track optimization request for AI description
            if (optimizationRequest) {
              console.log("Setting optimization history with:", optimizationRequest);
              setOptimizationHistory(prev => {
                const newHistory = [...prev, optimizationRequest];
                console.log("New optimization history:", newHistory);
                return newHistory;
              });
              // Clear manual changes when a new optimization is applied
              setManualChanges([]);
            } else {
              console.log("No optimization request provided");
            }
            
            if (replaceAll) {
              console.log("Replacing all options with new set");
              setSelectedOptions(optionIds);
              return;
            }
            
            const optionGroups = new Map<string, string>();
            for (const id of optionIds) {
              const opt = allOptions.find(o => o.OPTION_ID === id);
              if (opt) {
                console.log("Mapping:", opt.COMPONENT_GROUP, "->", id);
                optionGroups.set(opt.COMPONENT_GROUP, id);
              } else {
                console.log("Option not found:", id);
              }
            }
            console.log("Total groups mapped:", optionGroups.size);
            let newSelected = selectedOptions.filter(id => {
              const opt = allOptions.find(o => o.OPTION_ID === id);
              return opt && !optionGroups.has(opt.COMPONENT_GROUP);
            });
            newSelected = [...newSelected, ...optionIds];
            console.log("New selection count:", newSelected.length, "was:", selectedOptions.length);
            setSelectedOptions(newSelected);
          }}
        />
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-background rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="text-center mb-4">
              <div className="w-12 h-12 mx-auto mb-3 bg-red-100 rounded-full flex items-center justify-center">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h2 className="text-lg font-bold">Delete Engineering Spec?</h2>
            </div>
            <p className="text-sm text-muted-foreground text-center mb-4">
              This will permanently remove <strong>{deleteConfirm.docTitle}</strong> from the stage and re-index the search service.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-2 border rounded-lg font-medium hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteDoc(deleteConfirm.docId, deleteConfirm.docTitle)}
                className="flex-1 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteProgress && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-xl p-6 w-full max-w-md">
            <div className="text-center mb-4">
              <div className="w-12 h-12 mx-auto mb-3 bg-red-100 rounded-full flex items-center justify-center">
                <Loader2 className="h-6 w-6 text-red-600 animate-spin" />
              </div>
              <h2 className="text-lg font-bold">Deleting Document...</h2>
            </div>
            <div className="space-y-3">
              {[
                { key: 'lookup', label: 'Finding document' },
                { key: 'delete_chunks', label: 'Removing indexed chunks' },
                { key: 'delete_stage', label: 'Removing from stage' }
              ].map(({ key, label }) => {
                const step = deleteProgress.steps[key];
                return (
                  <div key={key} className="flex items-center gap-3">
                    {step?.status === 'pending' && <div className="h-4 w-4 rounded-full border-2 border-muted" />}
                    {step?.status === 'active' && <Loader2 className="h-4 w-4 text-red-600 animate-spin" />}
                    {step?.status === 'done' && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                    {step?.status === 'error' && <XCircle className="h-4 w-4 text-red-600" />}
                    <span className={`text-sm ${step?.status === 'active' ? 'font-medium' : step?.status === 'done' ? 'text-muted-foreground' : ''}`}>
                      {label}
                      {step?.message && <span className="text-muted-foreground ml-2">({step.message})</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {uploadModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-xl p-6 w-full max-w-md">
            <div className="text-center mb-4">
              <div className={`w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center ${uploadModal.error ? 'bg-red-100' : uploadModal.success ? 'bg-green-100' : 'bg-green-100'}`}>
                {uploadModal.error ? (
                  <XCircle className="h-6 w-6 text-red-600" />
                ) : uploadModal.success ? (
                  <CheckCircle2 className="h-6 w-6 text-green-600" />
                ) : (
                  <Loader2 className="h-6 w-6 text-green-600 animate-spin" />
                )}
              </div>
              <h2 className="text-lg font-bold">
                {uploadModal.error ? 'Upload Failed' : uploadModal.success ? 'Upload Complete!' : 'Uploading Document...'}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">{uploadModal.fileName}</p>
              {uploadModal.optionName && (
                <p className="text-xs text-muted-foreground">for {uploadModal.optionName}</p>
              )}
            </div>
            {uploadModal.error ? (
              <div className="text-center">
                <p className="text-sm text-red-600 mb-4">{uploadModal.error}</p>
                <button
                  onClick={() => setUploadModal(null)}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90"
                >
                  Close
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {(uploadModal.optionId ? [
                  { key: 'upload', label: 'Uploading to stage' },
                  { key: 'extract', label: 'Extracting & chunking document' },
                  { key: 'rules', label: 'Extracting validation rules (AI)' }
                ] : [
                  { key: 'upload', label: 'Uploading to stage' },
                  { key: 'extract', label: 'Extracting & chunking document' },
                  { key: 'detect', label: 'Detecting related parts' }
                ]).map(({ key, label }) => {
                  const step = uploadModal.steps[key];
                  return (
                    <div key={key} className="flex items-center gap-3">
                      {step?.status === 'pending' && <div className="h-4 w-4 rounded-full border-2 border-muted" />}
                      {step?.status === 'active' && <Loader2 className="h-4 w-4 text-green-600 animate-spin" />}
                      {step?.status === 'done' && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                      {step?.status === 'error' && <XCircle className="h-4 w-4 text-red-600" />}
                      <span className={`text-sm ${step?.status === 'active' ? 'font-medium' : step?.status === 'done' ? 'text-muted-foreground' : ''}`}>
                        {label}
                        {step?.message && <span className="text-muted-foreground ml-2">({step.message})</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {showSaveModal && (
        <SaveModal
          model={model}
          totalCost={totalCost}
          totalWeight={totalWeight}
          selectedOptions={selectedOptions}
          allOptions={allOptions}
          defaultOptions={defaultOptions}
          performanceScores={performanceScores}
          defaultScores={defaultScores}
          isValidated={isValidated}
          sessionId={chatSessionId}
          optimizationHistory={optimizationHistory}
          manualChanges={manualChanges}
          onClose={() => setShowSaveModal(false)}
          onSave={async () => {
            await onSave();
            setShowSaveModal(false);
          }}
        />
      )}

      {showVerifyModal && (
        <VerifyModal
          validation={validation}
          selectedOptions={selectedOptions}
          allOptions={allOptions}
          onClose={() => setShowVerifyModal(false)}
          validating={validating}
          onApplyFix={async (toRemove, toAdd) => {
            // Get the component groups of the parts we're adding
            const addedComponentGroups = toAdd.map(addId => 
              allOptions.find(o => o.OPTION_ID === addId)?.COMPONENT_GROUP
            ).filter(Boolean) as string[];
            
            // Remove: explicit IDs + any other parts from same component groups as the added parts
            const idsInSameGroups = allOptions
              .filter(o => addedComponentGroups.includes(o.COMPONENT_GROUP))
              .map(o => o.OPTION_ID);
            
            const allToRemove = new Set([...toRemove, ...idsInSameGroups]);
            const newOptions = selectedOptions.filter(id => !allToRemove.has(id));
            const updatedOptions = [...newOptions, ...toAdd];
            setSelectedOptions(updatedOptions);
            
            // Run incremental validation only on the newly added options
            // Pass updatedOptions explicitly since state hasn't updated yet
            setTimeout(() => {
              validateConfig(toAdd, updatedOptions);
            }, 100);
          }}
        />
      )}
    </div>
  );
}

interface ApplyAction {
  type: string;
  optionIds: string[];
  summary: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  applyAction?: ApplyAction;
  canApply?: boolean;
}

function ChatPanel({ model, selectedOptions, allOptions, sessionId, onClose, onApplyOptions }: {
  model: Model;
  selectedOptions: string[];
  allOptions: BOMOption[];
  sessionId: string;
  onClose: () => void;
  onApplyOptions?: (optionIds: string[], replaceAll?: boolean, optimizationRequest?: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: `Hi! I'm your configuration assistant for the ${model.MODEL_NM}. Ask me anything about options, or try "Maximize power while minimizing cost"!` }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingApply, setPendingApply] = useState<ApplyAction | null>(null);
  const [lastUserRequest, setLastUserRequest] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y
    };
  };

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

  async function handleApply() {
    if (!pendingApply || !onApplyOptions) return;
    onApplyOptions(pendingApply.optionIds, pendingApply.type === 'replace', lastUserRequest);
    
    if (lastUserRequest) {
      await fetch("/api/chat-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          modelId: model.MODEL_ID,
          role: 'user',
          content: lastUserRequest,
          optimizationApplied: true
        })
      });
    }
    
    setMessages(prev => [...prev, { 
      role: 'assistant', 
      content: `Done! I've applied ${pendingApply.optionIds.length} changes to your configuration.`
    }]);
    setPendingApply(null);
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    
    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);
    setPendingApply(null);

    const optionDetails = selectedOptions.map(id => {
      const opt = allOptions.find(o => o.OPTION_ID === id);
      return opt ? {
        optionId: id,
        optionName: opt.OPTION_NM,
        cost: opt.COST_USD,
        system: opt.SYSTEM_NM,
        subsystem: opt.SUBSYSTEM_NM,
        componentGroup: opt.COMPONENT_GROUP,
        performanceCategory: opt.PERFORMANCE_CATEGORY,
        performanceScore: opt.PERFORMANCE_SCORE
      } : null;
    }).filter(Boolean);

    const modelInfo = {
      modelId: model.MODEL_ID,
      modelName: model.MODEL_NM,
      baseMsrp: model.BASE_MSRP
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          modelId: model.MODEL_ID,
          modelInfo,
          selectedOptions: optionDetails,
        }),
      });
      const data = await res.json();
      
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: data.response || "I couldn't process that request. Please try again.",
        canApply: data.canApply,
        applyAction: data.applyAction
      }]);
      
      if (data.canApply && data.applyAction) {
        setPendingApply(data.applyAction);
        setLastUserRequest(userMessage);
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: "Sorry, I encountered an error. Please try again." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div 
      className="fixed w-96 h-[500px] bg-background border rounded-xl shadow-2xl flex flex-col z-50"
      style={{ 
        bottom: position.y === 0 ? '96px' : 'auto',
        right: position.x === 0 ? '24px' : 'auto',
        top: position.y !== 0 ? position.y : 'auto',
        left: position.x !== 0 ? position.x : 'auto'
      }}
    >
      <div 
        className="p-4 border-b flex items-center justify-between cursor-move select-none"
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-primary" />
          <span className="font-semibold">AI Assistant</span>
          <span className="text-xs text-muted-foreground">(drag to move)</span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-muted rounded">
          <X className="h-4 w-4" />
        </button>
      </div>
      
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={cn(
            "max-w-[85%] p-3 rounded-lg text-sm",
            msg.role === 'user' 
              ? "ml-auto bg-primary text-primary-foreground" 
              : "bg-muted"
          )}>
            <div className="whitespace-pre-wrap">{msg.content}</div>
          </div>
        ))}
        {loading && (
          <div className="bg-muted p-3 rounded-lg text-sm max-w-[85%]">
            <span className="animate-pulse">Thinking...</span>
          </div>
        )}
        {pendingApply && onApplyOptions && !loading && (
          <div className="bg-green-50 border border-green-200 p-3 rounded-lg">
            <p className="text-sm text-green-800 mb-2 font-medium">Apply these changes?</p>
            <p className="text-xs text-green-600 mb-3">{pendingApply.summary}</p>
            <button
              onClick={handleApply}
              className="w-full px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
            >
              Yes, apply {pendingApply.optionIds.length} changes
            </button>
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
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Ask about options..."
            className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="p-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function VerifyModal({ validation, selectedOptions, allOptions, onClose, onApplyFix, validating }: {
  validation: ValidationResult;
  selectedOptions: string[];
  allOptions: BOMOption[];
  onClose: () => void;
  onApplyFix?: (removeOptions: string[], addOptions: string[]) => void;
  validating?: boolean;
}) {
  const optionCount = selectedOptions.length;
  const systemCoverage = new Set(
    selectedOptions.map(id => allOptions.find(o => o.OPTION_ID === id)?.SYSTEM_NM).filter(Boolean)
  ).size;
  
  const isValid = validation.issues.length === 0;
  const hasFixPlan = validation.fixPlan && ((validation.fixPlan.add?.length || 0) > 0 || (validation.fixPlan.remove?.length || 0) > 0);

  function applyFixPlan() {
    if (!onApplyFix || !validation.fixPlan) return;
    onApplyFix(validation.fixPlan.remove, validation.fixPlan.add);
    // Don't close - let the parent handle incremental validation and update
  }

  function applySuggestion(optionId: string) {
    if (!onApplyFix) return;
    const opt = allOptions.find(o => o.OPTION_ID === optionId);
    if (opt) {
      const sameGroupOpts = allOptions
        .filter(o => o.COMPONENT_GROUP === opt.COMPONENT_GROUP)
        .map(o => o.OPTION_ID);
      const toRemove = sameGroupOpts.filter(id => selectedOptions.includes(id));
      onApplyFix(toRemove, [optionId]);
    }
  }

  const addOptions = (validation.fixPlan?.add || [])
    .map(id => allOptions.find(o => o.OPTION_ID === id))
    .filter(Boolean);
  const removeOptions = (validation.fixPlan?.remove || [])
    .map(id => allOptions.find(o => o.OPTION_ID === id))
    .filter(Boolean);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-background rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="text-center mb-6">
          {validating ? (
            <>
              <div className="w-16 h-16 mx-auto mb-4 bg-blue-100 rounded-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 text-blue-600 animate-spin" />
              </div>
              <h2 className="text-2xl font-bold text-blue-600">Re-validating...</h2>
              <p className="text-muted-foreground mt-2">Checking replacement parts for additional requirements.</p>
            </>
          ) : isValid ? (
            <>
              <div className="w-16 h-16 mx-auto mb-4 bg-green-100 rounded-full flex items-center justify-center">
                <ShieldCheck className="h-8 w-8 text-green-600" />
              </div>
              <h2 className="text-2xl font-bold text-green-600">Configuration Valid</h2>
              <p className="text-muted-foreground mt-2">Your configuration passes all engineering requirements.</p>
            </>
          ) : (
            <>
              <div className="w-16 h-16 mx-auto mb-4 bg-amber-100 rounded-full flex items-center justify-center">
                <AlertTriangle className="h-8 w-8 text-amber-600" />
              </div>
              <h2 className="text-2xl font-bold text-amber-600">Issues Found</h2>
              <p className="text-muted-foreground mt-2">Please review the following compatibility issues.</p>
            </>
          )}
        </div>

        <div className="space-y-4 mb-6">
          <div className="grid grid-cols-2 gap-4 text-center">
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-2xl font-bold">{optionCount}</div>
              <div className="text-xs text-muted-foreground">Options Selected</div>
            </div>
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-2xl font-bold">{systemCoverage}/8</div>
              <div className="text-xs text-muted-foreground">Systems Configured</div>
            </div>
          </div>

          {validation.issues.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-semibold text-destructive flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Issues ({validation.issues.length})
              </h3>
              {validation.issues.map((issue, i) => (
                <details key={i} className="group bg-destructive/10 border border-destructive/20 rounded-lg text-sm">
                  <summary className="p-3 cursor-pointer list-none flex items-center justify-between hover:bg-destructive/15 rounded-lg transition-colors">
                    <div className="flex items-center gap-2">
                      <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                      <span className="font-medium">{issue.title}</span>
                      {issue.specMismatches && issue.specMismatches.length > 1 && (
                        <span className="text-xs bg-destructive/20 text-destructive px-2 py-0.5 rounded-full">
                          {issue.specMismatches.length} issues
                        </span>
                      )}
                    </div>
                    {issue.sourceDoc && (
                      <span className="text-xs text-muted-foreground truncate max-w-[120px]" title={issue.sourceDoc}>
                        {issue.sourceDoc}
                      </span>
                    )}
                  </summary>
                  <div className="px-3 pb-3 pt-1 border-t border-destructive/20">
                    {issue.specMismatches && issue.specMismatches.length > 0 ? (
                      <div className="space-y-2">
                        {issue.specMismatches.map((mismatch, j) => (
                          <div key={j} className="flex items-start gap-2 text-muted-foreground">
                            <X className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                            <span>{mismatch.reason}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground">{issue.message}</p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}

          {hasFixPlan && onApplyFix && (
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <h3 className="font-semibold text-green-800 flex items-center gap-2 mb-3">
                <Check className="h-4 w-4" />
                Recommended Fix Plan
              </h3>
              {validation.fixPlan?.explanation && (
                <p className="text-sm text-green-700 mb-3">{validation.fixPlan.explanation}</p>
              )}
              {removeOptions.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs font-medium text-red-600 mb-1">Remove:</div>
                  {removeOptions.map(opt => opt && (
                    <div key={opt.OPTION_ID} className="text-sm text-red-700 pl-2">
                      − {opt.OPTION_NM}
                    </div>
                  ))}
                </div>
              )}
              {addOptions.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-green-600 mb-1">Add:</div>
                  {addOptions.map(opt => opt && (
                    <div key={opt.OPTION_ID} className="text-sm text-green-700 pl-2 flex justify-between">
                      <span>+ {opt.OPTION_NM}</span>
                      <span className="text-green-600">${opt.COST_USD.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={applyFixPlan}
                className="w-full py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors font-medium"
              >
                Apply Fix Plan
              </button>
            </div>
          )}

          {validation.suggestions.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-semibold text-amber-600 flex items-center gap-2">
                <Lightbulb className="h-4 w-4" />
                Recommendations ({validation.suggestions.length})
              </h3>
              {validation.suggestions.map((sug, i) => {
                const suggestedOptions = sug.suggestedOptions?.map(id => allOptions.find(o => o.OPTION_ID === id)).filter(Boolean) || [];
                return (
                  <div key={i} className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-sm">
                    <div className="font-medium">{sug.title}</div>
                    <p className="text-muted-foreground mt-1">{sug.message}</p>
                    {suggestedOptions.length > 0 && onApplyFix && (
                      <div className="mt-3 space-y-1.5">
                        {suggestedOptions.map(opt => opt && (
                          <button
                            key={opt.OPTION_ID}
                            onClick={() => applySuggestion(opt.OPTION_ID)}
                            className="w-full px-3 py-2 bg-amber-50 border border-amber-200 rounded text-left hover:bg-amber-100 transition-colors flex items-center justify-between"
                          >
                            <span className="font-medium text-amber-800">{opt.OPTION_NM}</span>
                            <span className="text-xs text-amber-600">+${opt.COST_USD.toLocaleString()}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
        >
          {isValid ? "Continue" : "Close"}
        </button>
      </div>
    </div>
  );
}

function SaveModal({ 
  model, totalCost, totalWeight, selectedOptions, allOptions, defaultOptions, performanceScores, defaultScores, isValidated, onClose, onSave, sessionId, optimizationHistory, manualChanges 
}: {
  model: Model;
  totalCost: number;
  totalWeight: number;
  selectedOptions: string[];
  allOptions: BOMOption[];
  defaultOptions: string[];
  performanceScores: Record<string, number>;
  defaultScores: Record<string, number>;
  isValidated?: boolean;
  onClose: () => void;
  onSave: () => Promise<void>;
  sessionId: string;
  optimizationHistory: string[];
  manualChanges: string[];
}) {
  const [configName, setConfigName] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  async function handleSave() {
    if (!configName.trim()) return;
    setSaving(true);
    try {
      const configRes = await fetch("/api/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configName,
          modelId: model.MODEL_ID,
          selectedOptions,
          totalCost,
          totalWeight,
          performanceSummary: performanceScores,
          notes,
          isValidated,
        }),
      });
      
      const configData = await configRes.json();
      if (configData.configId && sessionId) {
        await fetch("/api/chat-history", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, configId: configData.configId })
        });
      }
      
      onSave();
    } catch (err) {
      console.error("Error saving:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateDescription() {
    setGenerating(true);
    try {
      // Compute cost and weight delta from defaults
      let defaultCost = 0;
      let defaultWeight = 0;
      for (const optId of defaultOptions) {
        const opt = allOptions.find(o => o.OPTION_ID === optId);
        if (opt) {
          defaultCost += opt.COST_USD;
          defaultWeight += opt.WEIGHT_LBS;
        }
      }
      
      let selectedCost = 0;
      let selectedWeight = 0;
      for (const optId of selectedOptions) {
        const opt = allOptions.find(o => o.OPTION_ID === optId);
        if (opt) {
          selectedCost += opt.COST_USD;
          selectedWeight += opt.WEIGHT_LBS;
        }
      }
      
      const costDelta = selectedCost - defaultCost;
      const weightDelta = selectedWeight - defaultWeight;
      
      // If optimizationHistory is empty, try to fetch from chat history database
      let effectiveOptHistory = optimizationHistory;
      if (effectiveOptHistory.length === 0 && sessionId) {
        try {
          const historyRes = await fetch(`/api/chat-history?sessionId=${sessionId}`);
          if (historyRes.ok) {
            const historyData = await historyRes.json();
            if (historyData.optimizationRequests && historyData.optimizationRequests.length > 0) {
              effectiveOptHistory = historyData.optimizationRequests;
              console.log("Fetched optimization history from DB:", effectiveOptHistory);
            }
          }
        } catch (e) {
          console.error("Error fetching chat history:", e);
        }
      }
      
      const response = await fetch("/api/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelName: model.MODEL_NM,
          modelId: model.MODEL_ID,
          selectedOptions,
          totalCost,
          totalWeight,
          performanceSummary: performanceScores,
          optimizationHistory: effectiveOptHistory,
          manualChanges,
          costDelta,
          weightDelta
        })
      });

      const data = await response.json();
      if (data.description) {
        setNotes(data.description);
      }
    } catch (err) {
      console.error("Error generating description:", err);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-background rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Save Configuration</h2>
          {isValidated && (
            <div className="flex items-center gap-1 px-2 py-1 bg-green-100 rounded-full" title="Configuration validated">
              <ShieldCheck className="h-4 w-4 text-green-600" />
              <span className="text-xs font-medium text-green-600">Validated</span>
            </div>
          )}
        </div>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Configuration Name</label>
            <input
              type="text"
              value={configName}
              onChange={e => setConfigName(e.target.value)}
              placeholder="My Custom Build"
              className="w-full px-3 py-2 border border-border bg-background text-foreground rounded-lg focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
            />
          </div>
          
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium">Description (optional)</label>
              <button
                onClick={handleGenerateDescription}
                disabled={generating}
                className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {generating ? "Generating..." : "Generate with AI"}
              </button>
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add a description for this configuration..."
              rows={5}
              className="w-full px-3 py-2 border border-border bg-background text-foreground rounded-lg focus:outline-none focus:ring-2 focus:ring-primary resize-vertical placeholder:text-muted-foreground"
            />
          </div>
          
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 py-2 border rounded-lg font-medium hover:bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!configName.trim() || saving}
              className="flex-1 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
