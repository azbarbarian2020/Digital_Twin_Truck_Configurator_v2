"use client";

import { useState, useEffect } from "react";
import { ModelSelection } from "@/components/ModelSelection";
import { Configurator } from "@/components/Configurator";
import { Compare } from "@/components/Compare";
import { Header } from "@/components/Header";
import { ChatPanel } from "@/components/ChatPanel";
import { ModelSelectionSkeleton } from "@/components/Skeleton";

export type Model = {
  MODEL_ID: string;
  MODEL_NM: string;
  TRUCK_DESCRIPTION: string;
  BASE_MSRP: number;
  BASE_WEIGHT_LBS: number;
  MAX_PAYLOAD_LBS: number;
  MAX_TOWING_LBS: number;
  SLEEPER_AVAILABLE: boolean;
};

export type BOMOption = {
  OPTION_ID: string;
  SYSTEM_NM: string;
  SUBSYSTEM_NM: string;
  COMPONENT_GROUP: string;
  OPTION_NM: string;
  DESCRIPTION: string;
  COST_USD: number;
  WEIGHT_LBS: number;
  PERFORMANCE_CATEGORY: string;
  PERFORMANCE_SCORE: number;
  IS_DEFAULT: boolean;
  SOURCE_COUNTRY: string;
  TARIFF_AMOUNT_USD: number;
  DUTY_RATE_PCT: number;
  TOTAL_COST_WITH_TARIFF: number;
  TRADE_AGREEMENT: string;
  SPECS?: Record<string, unknown> | null;
};

export type SavedConfig = {
  CONFIG_ID: string;
  CONFIG_NAME: string;
  MODEL_ID: string;
  CREATED_BY: string;
  TOTAL_COST_USD: number;
  TOTAL_WEIGHT_LBS: number;
  PERFORMANCE_SUMMARY: Record<string, number>;
  CONFIG_OPTIONS: string[];
  NOTES: string;
  IS_VALIDATED?: boolean;
};

type Page = "models" | "configurator" | "compare";

export default function Home() {
  const [page, setPage] = useState<Page>("models");
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [allOptions, setAllOptions] = useState<BOMOption[]>([]);
  const [savedConfigs, setSavedConfigs] = useState<SavedConfig[]>([]);
  const [loadedConfigName, setLoadedConfigName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingLoadedConfig, setPendingLoadedConfig] = useState<SavedConfig | null>(null);
  const [chatSessionId, setChatSessionId] = useState(() => `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);

  useEffect(() => {
    loadModels();
    loadSavedConfigs();
  }, []);

  // Re-apply loaded configuration when allOptions become available
  // Merge saved config options with defaults for component groups not in the saved config
  useEffect(() => {
    if (pendingLoadedConfig && allOptions.length > 0) {
      const savedOptionIds = pendingLoadedConfig.CONFIG_OPTIONS || [];
      
      // Find which component groups are covered by the saved config
      const coveredComponentGroups = new Set<string>();
      for (const optId of savedOptionIds) {
        const opt = allOptions.find(o => o.OPTION_ID === optId);
        if (opt) {
          coveredComponentGroups.add(opt.COMPONENT_GROUP);
        }
      }
      
      // Get default options for component groups NOT in the saved config
      const defaultsForUncoveredGroups = allOptions
        .filter(o => o.IS_DEFAULT && !coveredComponentGroups.has(o.COMPONENT_GROUP))
        .map(o => o.OPTION_ID);
      
      // Merge: saved options + defaults for uncovered component groups
      const mergedOptions = [...savedOptionIds, ...defaultsForUncoveredGroups];
      
      setSelectedOptions(mergedOptions);
      setPendingLoadedConfig(null);
    }
  }, [pendingLoadedConfig, allOptions]);

  async function loadModels() {
    try {
      const res = await fetch("/api/models");
      const data = await res.json();
      if (Array.isArray(data)) {
        setModels(data);
      } else {
        console.error("Models API returned non-array:", data);
        setModels([]);
      }
    } catch (err) {
      console.error("Error loading models:", err);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadSavedConfigs() {
    try {
      const res = await fetch("/api/configs");
      const data = await res.json();
      if (Array.isArray(data)) {
        setSavedConfigs(data);
      } else {
        console.error("Configs API returned non-array:", data);
        setSavedConfigs([]);
      }
    } catch (err) {
      console.error("Error loading configs:", err);
      setSavedConfigs([]);
    }
  }

  function handleSelectModel(model: Model) {
    setSelectedModel(model);
    setSelectedOptions([]);
    setAllOptions([]);
    setLoadedConfigName(null);
    setChatSessionId(`session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    setPage("configurator");
  }

  function handleBack() {
    setPage("models");
    setSelectedModel(null);
    setLoadedConfigName(null);
    setChatSessionId(`session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  }

  function handleApplyOptionsFromChat(optionIds: string[], action: 'add' | 'remove' | 'replace') {
    if (action === 'add' || action === 'replace') {
      // Both add and replace should ensure single selection per component group
      // Use composite key: System + Subsystem + Component Group to identify unique groups
      // This is critical because COMPONENT_GROUP alone is not unique (e.g., "Brake Type" exists
      // in Engine > Engine Brake, Front Axle > Front Brakes, and Rear Axle > Rear Brakes)
      setSelectedOptions(prev => {
        let newOptions = [...prev];
        for (const newId of optionIds) {
          const newOpt = allOptions.find(o => o.OPTION_ID === newId);
          if (newOpt) {
            // Create composite key for the new option's group
            const newGroupKey = `${newOpt.SYSTEM_NM}|${newOpt.SUBSYSTEM_NM}|${newOpt.COMPONENT_GROUP}`;
            // Remove any existing option in the same composite group
            newOptions = newOptions.filter(existingId => {
              const existingOpt = allOptions.find(o => o.OPTION_ID === existingId);
              if (!existingOpt) return true;
              const existingGroupKey = `${existingOpt.SYSTEM_NM}|${existingOpt.SUBSYSTEM_NM}|${existingOpt.COMPONENT_GROUP}`;
              return existingGroupKey !== newGroupKey;
            });
            // Add the new option
            if (!newOptions.includes(newId)) {
              newOptions.push(newId);
            }
          }
        }
        return newOptions;
      });
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Header 
          page="models" 
          onNavigate={() => {}} 
          onBack={() => {}}
          savedConfigCount={0}
        />
        <ModelSelectionSkeleton />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header 
        page={page} 
        onNavigate={setPage} 
        onBack={handleBack}
        modelName={selectedModel?.MODEL_NM}
        savedConfigCount={savedConfigs.length}
      />
      
      <main>
        {page === "models" && (
          <ModelSelection 
            models={models} 
            onSelectModel={handleSelectModel} 
          />
        )}
        
        {page === "configurator" && selectedModel && (
          <Configurator
            model={selectedModel}
            selectedOptions={selectedOptions}
            setSelectedOptions={setSelectedOptions}
            onSave={loadSavedConfigs}
            onOptionsLoaded={setAllOptions}
            loadedConfigName={loadedConfigName}
            onConfigNameChange={setLoadedConfigName}
            sessionId={chatSessionId}
          />
        )}
        
        {page === "compare" && (
          <Compare 
            savedConfigs={savedConfigs}
            models={models}
            onLoadConfig={(config) => {
              const model = models.find(m => m.MODEL_ID === config.MODEL_ID);
              if (model) {
                setLoadedConfigName(config.CONFIG_NAME);
                // Set options immediately before navigating
                setSelectedOptions(config.CONFIG_OPTIONS || []);
                setPendingLoadedConfig(config); // Keep as backup for re-application
                setSelectedModel(model);
                setPage("configurator");
              }
            }}
            onUpdateConfig={loadSavedConfigs}
          />
        )}
      </main>
      
      <ChatPanel 
        modelId={selectedModel?.MODEL_ID}
        modelInfo={selectedModel ? {
          modelId: selectedModel.MODEL_ID,
          modelName: selectedModel.MODEL_NM,
          baseMsrp: selectedModel.BASE_MSRP
        } : undefined}
        selectedOptions={allOptions.length > 0 ? selectedOptions.map(id => {
          const opt = allOptions.find(o => o.OPTION_ID === id);
          return opt ? {
            optionId: id,
            optionName: opt.OPTION_NM,
            cost: opt.COST_USD,
            system: opt.SYSTEM_NM,
            subsystem: opt.SUBSYSTEM_NM,
            componentGroup: opt.COMPONENT_GROUP
          } : null;
        }).filter(Boolean) as any : []}
        onApplyOptions={handleApplyOptionsFromChat}
        sessionId={chatSessionId}
      />
    </div>
  );
}
