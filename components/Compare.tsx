"use client";

import { useState } from "react";
import type { Model, SavedConfig } from "@/app/page";
import { formatCurrency, formatWeight, cn } from "@/lib/utils";
import { Truck, Upload, X, ArrowLeftRight, FileText, ChevronDown, ChevronUp, Edit2, Trash2 } from "lucide-react";
import { ConfigurationReport } from "./ConfigurationReport";

interface CompareProps {
  savedConfigs: SavedConfig[];
  models: Model[];
  onLoadConfig: (config: SavedConfig) => void;
  onUpdateConfig?: () => Promise<void>;
}

export function Compare({ savedConfigs, models, onLoadConfig, onUpdateConfig }: CompareProps) {
  const [leftConfig, setLeftConfig] = useState<SavedConfig | null>(null);
  const [rightConfig, setRightConfig] = useState<SavedConfig | null>(null);
  const [showSelector, setShowSelector] = useState<"left" | "right" | null>(null);
  const [reportConfig, setReportConfig] = useState<SavedConfig | null>(null);
  const [showDetailedBOM, setShowDetailedBOM] = useState(false);
  const [editConfig, setEditConfig] = useState<SavedConfig | null>(null);
  const [deleteConfig, setDeleteConfig] = useState<SavedConfig | null>(null);

  async function handleDeleteConfig(configId: string) {
    try {
      await fetch(`/api/configs/${configId}`, {
        method: 'DELETE'
      });
      await onUpdateConfig?.();
      setDeleteConfig(null);
      if (leftConfig?.CONFIG_ID === configId) setLeftConfig(null);
      if (rightConfig?.CONFIG_ID === configId) setRightConfig(null);
    } catch (error) {
      console.error('Error deleting config:', error);
    }
  }

  async function handleUpdateConfig(configId: string, configName: string, notes: string) {
    try {
      await fetch('/api/configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configId, configName, notes })
      });
      await onUpdateConfig?.();
      setEditConfig(null);
    } catch (error) {
      console.error('Error updating config:', error);
    }
  }

  if (savedConfigs.length === 0) {
    return (
      <div className="container max-w-7xl mx-auto px-4 py-24">
        <div className="text-center">
          <div className="w-32 h-32 mx-auto mb-6 bg-muted rounded-full flex items-center justify-center">
            <Truck className="h-16 w-16 text-muted-foreground" />
          </div>
          <h2 className="text-2xl font-bold mb-2">No Saved Configurations</h2>
          <p className="text-muted-foreground mb-6">
            Configure a truck and save it to compare different builds side by side.
          </p>
        </div>
      </div>
    );
  }

  const performanceCategories = ["Power", "Economy", "Comfort", "Durability", "Safety", "Hauling", "Emissions", "Cooling"];

  function ComparisonSlot({ config, side, onSelect, onClear }: {
    config: SavedConfig | null;
    side: "left" | "right";
    onSelect: () => void;
    onClear: () => void;
  }) {
    if (!config) {
      return (
        <button
          onClick={onSelect}
          className="flex-1 border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center gap-4 hover:bg-muted/50 hover:border-primary/50 transition-colors min-h-[500px]"
        >
          <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center">
            <Truck className="h-10 w-10 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="font-medium">Select Configuration</p>
            <p className="text-sm text-muted-foreground">Click to choose a saved build</p>
          </div>
        </button>
      );
    }

    const model = models.find(m => m.MODEL_ID === config.MODEL_ID);
    const perf = config.PERFORMANCE_SUMMARY || {};
    const otherConfig = side === "left" ? rightConfig : leftConfig;
    const otherPerf = otherConfig?.PERFORMANCE_SUMMARY || {};

    return (
      <div className="flex-1 border rounded-xl overflow-hidden bg-card">
        <div className="p-4 border-b bg-muted/50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-lg">{config.CONFIG_NAME}</h3>
            <p className="text-sm text-muted-foreground">{model?.MODEL_NM || config.MODEL_ID}</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setReportConfig(config)}
              className="p-2 hover:bg-muted rounded-lg transition-colors"
              title="View detailed report"
            >
              <FileText className="h-4 w-4" />
            </button>
            <button
              onClick={onClear}
              className="p-2 hover:bg-muted rounded-lg transition-colors"
              title="Remove from comparison"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        
        <div className="p-6 space-y-6">
          <div className="text-center py-4 bg-muted/30 rounded-lg">
            <div className="text-3xl font-bold">{formatCurrency(config.TOTAL_COST_USD)}</div>
            <div className="text-sm text-muted-foreground">{formatWeight(config.TOTAL_WEIGHT_LBS)}</div>
            {otherConfig && (
              <div className="mt-2 text-sm">
                {config.TOTAL_COST_USD > otherConfig.TOTAL_COST_USD ? (
                  <span className="text-red-500">+{formatCurrency(config.TOTAL_COST_USD - otherConfig.TOTAL_COST_USD)} more</span>
                ) : config.TOTAL_COST_USD < otherConfig.TOTAL_COST_USD ? (
                  <span className="text-green-600">-{formatCurrency(otherConfig.TOTAL_COST_USD - config.TOTAL_COST_USD)} less</span>
                ) : (
                  <span className="text-muted-foreground">Same price</span>
                )}
              </div>
            )}
          </div>
          
          <div className="space-y-3">
            {performanceCategories.map(cat => {
              const score = perf[cat] || 0;
              const pct = Math.round(score * 20);
              const otherScore = otherPerf[cat] || 0;
              const otherPct = Math.round(otherScore * 20);
              const diff = pct - otherPct;
              const hasDiff = otherConfig && diff !== 0;
              
              return (
                <div key={cat}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-muted-foreground">{cat}</span>
                    <span className={cn(
                      "font-medium",
                      hasDiff && diff > 0 && "text-green-600",
                      hasDiff && diff < 0 && "text-red-500"
                    )}>
                      {pct}%
                      {hasDiff && (
                        <span className="ml-1 text-xs">
                          ({diff > 0 ? "+" : ""}{diff})
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="h-3 bg-muted rounded-full overflow-hidden relative">
                    <div 
                      className={cn(
                        "h-full rounded-full transition-all",
                        hasDiff && diff > 0 ? "bg-green-500" : hasDiff && diff < 0 ? "bg-red-400" : "bg-primary"
                      )}
                      style={{ width: `${pct}%` }}
                    />
                    {otherConfig && (
                      <div 
                        className="absolute top-0 bottom-0 w-0.5 bg-foreground/50"
                        style={{ left: `${otherPct}%` }}
                        title={`Other: ${otherPct}%`}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          
          {config.NOTES && (
            <p className="text-sm text-muted-foreground italic border-t pt-4">
              "{config.NOTES}"
            </p>
          )}
          
          <div className="flex gap-2">
            <button
              onClick={onSelect}
              className="flex-1 py-2 border rounded-lg font-medium hover:bg-muted transition-colors text-sm"
            >
              Change
            </button>
            <button
              onClick={() => onLoadConfig(config)}
              className="flex-1 py-2 bg-primary text-primary-foreground rounded-lg font-medium flex items-center justify-center gap-2 hover:bg-primary/90 transition-colors text-sm"
            >
              <Upload className="h-4 w-4" />
              Load
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Compare Configurations</h1>
        <div className="flex items-center gap-4">
          {(leftConfig || rightConfig) && (
            <button
              onClick={() => setShowDetailedBOM(!showDetailedBOM)}
              className="flex items-center gap-2 px-4 py-2 bg-muted rounded-lg hover:bg-muted/80 transition-colors text-sm font-medium"
            >
              {showDetailedBOM ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {showDetailedBOM ? "Hide" : "Show"} Detailed BOM
            </button>
          )}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ArrowLeftRight className="h-4 w-4" />
            <span>Select two builds to compare side by side</span>
          </div>
        </div>
      </div>
      
      <div className="flex gap-6 mb-8">
        <ComparisonSlot
          config={leftConfig}
          side="left"
          onSelect={() => setShowSelector("left")}
          onClear={() => setLeftConfig(null)}
        />
        
        <div className="flex items-center">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            <ArrowLeftRight className="h-5 w-5 text-muted-foreground" />
          </div>
        </div>
        
        <ComparisonSlot
          config={rightConfig}
          side="right"
          onSelect={() => setShowSelector("right")}
          onClear={() => setRightConfig(null)}
        />
      </div>

      {showDetailedBOM && (leftConfig || rightConfig) && (
        <DetailedBOMComparison 
          leftConfig={leftConfig} 
          rightConfig={rightConfig}
          models={models}
        />
      )}

      {showSelector && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowSelector(null)}>
          <div className="bg-background rounded-xl p-6 w-full max-w-2xl max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">Select Configuration</h2>
              <button onClick={() => setShowSelector(null)} className="p-2 hover:bg-muted rounded-lg">
                <X className="h-5 w-5" />
              </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {savedConfigs.map(config => {
                const model = models.find(m => m.MODEL_ID === config.MODEL_ID);
                const isSelected = (showSelector === "left" && leftConfig?.CONFIG_ID === config.CONFIG_ID) ||
                                   (showSelector === "right" && rightConfig?.CONFIG_ID === config.CONFIG_ID);
                const isOtherSide = (showSelector === "left" && rightConfig?.CONFIG_ID === config.CONFIG_ID) ||
                                    (showSelector === "right" && leftConfig?.CONFIG_ID === config.CONFIG_ID);
                
                return (
                  <div
                    key={config.CONFIG_ID}
                    className={cn(
                      "border-2 rounded-xl transition-all relative",
                      isSelected ? "border-primary bg-primary/5" : "border-transparent bg-muted/30",
                      isOtherSide && "opacity-50"
                    )}
                  >
                    <button
                      onClick={() => {
                        if (!isOtherSide) {
                          if (showSelector === "left") {
                            setLeftConfig(config);
                          } else {
                            setRightConfig(config);
                          }
                          setShowSelector(null);
                        }
                      }}
                      disabled={isOtherSide}
                      className="w-full p-4 text-left transition-all hover:bg-muted/50 rounded-xl disabled:cursor-not-allowed"
                    >
                      <div className="font-bold">{config.CONFIG_NAME}</div>
                      <div className="text-sm text-muted-foreground mb-2">{model?.MODEL_NM || config.MODEL_ID}</div>
                      <div className="flex justify-between text-sm">
                        <span className="font-semibold">{formatCurrency(config.TOTAL_COST_USD)}</span>
                        <span className="text-muted-foreground">{formatWeight(config.TOTAL_WEIGHT_LBS)}</span>
                      </div>
                      {isOtherSide && (
                        <div className="text-xs text-amber-600 mt-2">Already selected in other slot</div>
                      )}
                    </button>
                    
                    {/* Action buttons */}
                    <div className="absolute top-2 right-2 flex gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditConfig(config);
                        }}
                        className="p-1.5 bg-background/80 backdrop-blur-sm hover:bg-muted rounded-md transition-colors"
                        title="Edit configuration"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfig(config);
                        }}
                        className="p-1.5 bg-background/80 backdrop-blur-sm hover:bg-destructive hover:text-destructive-foreground rounded-md transition-colors"
                        title="Delete configuration"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {reportConfig && (
        <ConfigurationReport
          config={reportConfig}
          model={models.find(m => m.MODEL_ID === reportConfig.MODEL_ID) || models[0]}
          onClose={() => setReportConfig(null)}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfig && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setDeleteConfig(null)}>
          <div className="bg-background rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="text-xl font-bold mb-4">Delete Configuration</h2>
            <p className="text-muted-foreground mb-6">
              Are you sure you want to delete "{deleteConfig.CONFIG_NAME}"? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfig(null)}
                className="flex-1 py-2 border rounded-lg font-medium hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteConfig(deleteConfig.CONFIG_ID)}
                className="flex-1 py-2 bg-destructive text-destructive-foreground rounded-lg font-medium hover:bg-destructive/90 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editConfig && (
        <EditConfigModal
          config={editConfig}
          onClose={() => setEditConfig(null)}
          onSave={handleUpdateConfig}
        />
      )}
    </div>
  );
}

function EditConfigModal({ 
  config, 
  onClose, 
  onSave 
}: {
  config: SavedConfig;
  onClose: () => void;
  onSave: (configId: string, configName: string, notes: string) => Promise<void>;
}) {
  const [configName, setConfigName] = useState(config.CONFIG_NAME);
  const [notes, setNotes] = useState(config.NOTES || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!configName.trim()) return;
    setSaving(true);
    try {
      await onSave(config.CONFIG_ID, configName.trim(), notes);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-background rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-bold mb-4">Edit Configuration</h2>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Configuration Name</label>
            <input
              type="text"
              value={configName}
              onChange={e => setConfigName(e.target.value)}
              placeholder="Configuration name"
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium mb-1">Description (optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add a description..."
              rows={3}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
          </div>
          
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="flex-1 py-2 border rounded-lg font-medium hover:bg-muted transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!configName.trim() || saving}
              className="flex-1 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface BOMItem {
  optionId: string;
  optionName: string;
  cost: number;
  weight: number;
  status: "base" | "default" | "upgraded" | "downgraded";
  performanceCategory?: string;
}

interface ComponentGroup {
  name: string;
  selectedItem: BOMItem | null;
}

interface Subsystem {
  name: string;
  componentGroups: ComponentGroup[];
}

interface System {
  name: string;
  subsystems: Subsystem[];
  totalCost: number;
  totalWeight: number;
}

interface ReportData {
  bomHierarchy: System[];
}

function DetailedBOMComparison({ 
  leftConfig, 
  rightConfig,
  models 
}: { 
  leftConfig: SavedConfig | null; 
  rightConfig: SavedConfig | null;
  models: Model[];
}) {
  const [leftData, setLeftData] = useState<ReportData | null>(null);
  const [rightData, setRightData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSystems, setExpandedSystems] = useState<Set<string>>(new Set());

  useState(() => {
    loadData();
  });

  async function loadData() {
    setLoading(true);
    try {
      const promises: Promise<void>[] = [];
      
      if (leftConfig) {
        const optionsParam = encodeURIComponent(JSON.stringify(leftConfig.CONFIG_OPTIONS));
        promises.push(
          fetch(`/api/report?modelId=${leftConfig.MODEL_ID}&options=${optionsParam}`)
            .then(res => res.json())
            .then(data => setLeftData(data))
        );
      }
      
      if (rightConfig) {
        const optionsParam = encodeURIComponent(JSON.stringify(rightConfig.CONFIG_OPTIONS));
        promises.push(
          fetch(`/api/report?modelId=${rightConfig.MODEL_ID}&options=${optionsParam}`)
            .then(res => res.json())
            .then(data => setRightData(data))
        );
      }
      
      await Promise.all(promises);
      
      const allSystems = new Set<string>();
      leftData?.bomHierarchy.forEach(s => allSystems.add(s.name));
      rightData?.bomHierarchy.forEach(s => allSystems.add(s.name));
      setExpandedSystems(allSystems);
    } catch (err) {
      console.error("Error loading BOM data:", err);
    } finally {
      setLoading(false);
    }
  }

  function toggleSystem(name: string) {
    const newExpanded = new Set(expandedSystems);
    if (newExpanded.has(name)) {
      newExpanded.delete(name);
    } else {
      newExpanded.add(name);
    }
    setExpandedSystems(newExpanded);
  }

  function getStatusBadge(status: BOMItem["status"]) {
    switch (status) {
      case "default":
        return <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] rounded font-medium">DEF</span>;
      case "upgraded":
        return <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] rounded font-medium">UPG</span>;
      case "downgraded":
        return <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[10px] rounded font-medium">DWN</span>;
      default:
        return <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-[10px] rounded font-medium">BASE</span>;
    }
  }

  if (loading) {
    return (
      <div className="border rounded-xl p-8 text-center">
        <p className="text-muted-foreground">Loading detailed BOM comparison...</p>
      </div>
    );
  }

  const allSystems = new Set<string>();
  leftData?.bomHierarchy.forEach(s => allSystems.add(s.name));
  rightData?.bomHierarchy.forEach(s => allSystems.add(s.name));

  return (
    <div className="border rounded-xl overflow-hidden">
      <div className="p-4 bg-muted/50 border-b">
        <h3 className="font-bold">Detailed Bill of Materials Comparison</h3>
        <p className="text-sm text-muted-foreground">Side-by-side comparison of selected options</p>
      </div>
      
      <div className="divide-y">
        {Array.from(allSystems).sort().map(systemName => {
          const leftSystem = leftData?.bomHierarchy.find(s => s.name === systemName);
          const rightSystem = rightData?.bomHierarchy.find(s => s.name === systemName);
          const isExpanded = expandedSystems.has(systemName);
          
          return (
            <div key={systemName}>
              <button
                onClick={() => toggleSystem(systemName)}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4 rotate-180" />}
                  <span className="font-semibold">{systemName}</span>
                </div>
                <div className="flex gap-8 text-sm">
                  <span className={cn(
                    "w-24 text-right",
                    leftSystem ? "" : "text-muted-foreground"
                  )}>
                    {leftSystem ? formatCurrency(leftSystem.totalCost) : "-"}
                  </span>
                  <span className={cn(
                    "w-24 text-right",
                    rightSystem ? "" : "text-muted-foreground"
                  )}>
                    {rightSystem ? formatCurrency(rightSystem.totalCost) : "-"}
                  </span>
                </div>
              </button>
              
              {isExpanded && (
                <div className="px-4 pb-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      {leftSystem?.subsystems.map(ss => (
                        ss.componentGroups.filter(cg => cg.selectedItem).map(cg => (
                          <div key={`${ss.name}-${cg.name}`} className="p-2 bg-muted/20 rounded text-sm">
                            <div className="text-xs text-muted-foreground mb-1">
                              {ss.name} &gt; {cg.name}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="truncate font-medium">{cg.selectedItem?.optionName}</span>
                                {cg.selectedItem && getStatusBadge(cg.selectedItem.status)}
                              </div>
                              <span className="text-xs shrink-0">
                                {cg.selectedItem?.cost === 0 ? "Incl" : formatCurrency(cg.selectedItem?.cost || 0)}
                              </span>
                            </div>
                            {cg.selectedItem?.performanceCategory && (
                              <div className="mt-1">
                                <span className={cn(
                                  "text-[10px] px-1.5 py-0.5 rounded",
                                  cg.selectedItem.performanceCategory === 'Efficiency' ? "bg-green-100 text-green-700" :
                                  cg.selectedItem.performanceCategory === 'Safety' ? "bg-blue-100 text-blue-700" :
                                  cg.selectedItem.performanceCategory === 'Comfort' ? "bg-purple-100 text-purple-700" :
                                  cg.selectedItem.performanceCategory === 'Economy' ? "bg-amber-100 text-amber-700" :
                                  cg.selectedItem.performanceCategory === 'Power' ? "bg-red-100 text-red-700" :
                                  cg.selectedItem.performanceCategory === 'Durability' ? "bg-slate-100 text-slate-700" :
                                  cg.selectedItem.performanceCategory === 'Hauling' ? "bg-orange-100 text-orange-700" :
                                  "bg-gray-100 text-gray-700"
                                )}>
                                  {cg.selectedItem.performanceCategory}
                                </span>
                              </div>
                            )}
                          </div>
                        ))
                      ))}
                      {!leftSystem && leftConfig && (
                        <div className="p-2 text-sm text-muted-foreground italic">
                          No options in this system
                        </div>
                      )}
                      {!leftConfig && (
                        <div className="p-2 text-sm text-muted-foreground italic">
                          No configuration selected
                        </div>
                      )}
                    </div>
                    
                    <div className="space-y-1">
                      {rightSystem?.subsystems.map(ss => (
                        ss.componentGroups.filter(cg => cg.selectedItem).map(cg => (
                          <div key={`${ss.name}-${cg.name}`} className="p-2 bg-muted/20 rounded text-sm">
                            <div className="text-xs text-muted-foreground mb-1">
                              {ss.name} &gt; {cg.name}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="truncate font-medium">{cg.selectedItem?.optionName}</span>
                                {cg.selectedItem && getStatusBadge(cg.selectedItem.status)}
                              </div>
                              <span className="text-xs shrink-0">
                                {cg.selectedItem?.cost === 0 ? "Incl" : formatCurrency(cg.selectedItem?.cost || 0)}
                              </span>
                            </div>
                            {cg.selectedItem?.performanceCategory && (
                              <div className="mt-1">
                                <span className={cn(
                                  "text-[10px] px-1.5 py-0.5 rounded",
                                  cg.selectedItem.performanceCategory === 'Efficiency' ? "bg-green-100 text-green-700" :
                                  cg.selectedItem.performanceCategory === 'Safety' ? "bg-blue-100 text-blue-700" :
                                  cg.selectedItem.performanceCategory === 'Comfort' ? "bg-purple-100 text-purple-700" :
                                  cg.selectedItem.performanceCategory === 'Economy' ? "bg-amber-100 text-amber-700" :
                                  cg.selectedItem.performanceCategory === 'Power' ? "bg-red-100 text-red-700" :
                                  cg.selectedItem.performanceCategory === 'Durability' ? "bg-slate-100 text-slate-700" :
                                  cg.selectedItem.performanceCategory === 'Hauling' ? "bg-orange-100 text-orange-700" :
                                  "bg-gray-100 text-gray-700"
                                )}>
                                  {cg.selectedItem.performanceCategory}
                                </span>
                              </div>
                            )}
                          </div>
                        ))
                      ))}
                      {!rightSystem && rightConfig && (
                        <div className="p-2 text-sm text-muted-foreground italic">
                          No options in this system
                        </div>
                      )}
                      {!rightConfig && (
                        <div className="p-2 text-sm text-muted-foreground italic">
                          No configuration selected
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
