"use client";

import { useState, useEffect, useMemo } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Model, SavedConfig } from "@/app/page";
import { formatCurrency, formatWeight, cn } from "@/lib/utils";
import { FileText, Download, X, Loader2, Check, ChevronRight, ShieldCheck } from "lucide-react";

interface BOMItem {
  optionId: string;
  optionName: string;
  description: string;
  cost: number;
  weight: number;
  performanceCategory: string;
  performanceScore: number;
  status: "base" | "default" | "upgraded" | "downgraded";
  isSelected: boolean;
}

interface ComponentGroup {
  name: string;
  items: BOMItem[];
  selectedItem: BOMItem | null;
  totalCost: number;
  totalWeight: number;
}

interface Subsystem {
  name: string;
  componentGroups: ComponentGroup[];
  totalCost: number;
  totalWeight: number;
}

interface System {
  name: string;
  subsystems: Subsystem[];
  totalCost: number;
  totalWeight: number;
}

interface ReportData {
  model: Model;
  bomHierarchy: System[];
  selectedOptionIds: string[];
  defaultOptionIds: string[];
}

interface ConfigurationReportProps {
  config: SavedConfig;
  model: Model;
  onClose: () => void;
}

export function ConfigurationReport({ config, model, onClose }: ConfigurationReportProps) {
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [showAllOptions, setShowAllOptions] = useState(false);

  useEffect(() => {
    loadReportData();
  }, [config.CONFIG_ID]);

  const calculatedPerformanceScores = useMemo(() => {
    if (!reportData) return {};
    const scores: Record<string, number[]> = {};
    for (const system of reportData.bomHierarchy) {
      for (const subsystem of system.subsystems) {
        for (const cg of subsystem.componentGroups) {
          if (cg.selectedItem) {
            const cat = cg.selectedItem.performanceCategory;
            const score = cg.selectedItem.performanceScore;
            if (cat) {
              if (!scores[cat]) scores[cat] = [];
              scores[cat].push(score);
            }
          }
        }
      }
    }
    const avgScores: Record<string, number> = {};
    for (const [cat, vals] of Object.entries(scores)) {
      avgScores[cat] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return avgScores;
  }, [reportData]);

  async function loadReportData() {
    setLoading(true);
    try {
      const optionsParam = encodeURIComponent(JSON.stringify(config.CONFIG_OPTIONS));
      const res = await fetch(`/api/report?modelId=${config.MODEL_ID}&options=${optionsParam}`);
      const data = await res.json();
      setReportData(data);
    } catch (err) {
      console.error("Error loading report:", err);
    } finally {
      setLoading(false);
    }
  }

  function getStatusBadge(status: BOMItem["status"]) {
    switch (status) {
      case "default":
        return <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full font-medium">Default</span>;
      case "upgraded":
        return <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full font-medium">Upgraded</span>;
      case "downgraded":
        return <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs rounded-full font-medium">Downgraded</span>;
      default:
        return <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full font-medium">Base</span>;
    }
  }

  function getStatusText(status: BOMItem["status"]) {
    switch (status) {
      case "default": return "Default";
      case "upgraded": return "Upgraded";
      case "downgraded": return "Downgraded";
      default: return "Base";
    }
  }

  function generatePDF() {
    if (!reportData) return;
    setGeneratingPdf(true);

    try {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 15;
      let yPos = margin;

      doc.setFillColor(25, 55, 95);
      doc.rect(0, 0, pageWidth, 40, "F");

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text("DIGITAL TWIN TRUCK CONFIGURATOR", margin, 15);
      
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("Configuration Report", margin, 28);
      
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.text(`Generated: ${new Date().toLocaleDateString("en-US", { 
        year: "numeric", month: "long", day: "numeric" 
      })}`, pageWidth - margin, 15, { align: "right" });

      yPos = 50;

      doc.setTextColor(25, 55, 95);
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text(config.CONFIG_NAME, margin, yPos);
      
      if (config.IS_VALIDATED) {
        const nameWidth = doc.getTextWidth(config.CONFIG_NAME);
        doc.setFillColor(220, 252, 231);
        doc.roundedRect(margin + nameWidth + 5, yPos - 5, 55, 8, 2, 2, "F");
        doc.setTextColor(22, 163, 74);
        doc.setFontSize(7);
        doc.setFont("helvetica", "bold");
        doc.text("✓ VALIDATED", margin + nameWidth + 10, yPos - 0.5);
      }
      yPos += 6;

      doc.setTextColor(100, 100, 100);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(`Base Model: ${model.MODEL_NM}`, margin, yPos);
      yPos += 10;

      doc.setFillColor(245, 247, 250);
      doc.roundedRect(margin, yPos, pageWidth - 2 * margin, 28, 3, 3, "F");

      const boxY = yPos + 3;
      const colWidth = (pageWidth - 2 * margin) / 3;
      const col1 = margin + colWidth / 2;
      const col2 = margin + colWidth + colWidth / 2;
      const col3 = margin + 2 * colWidth + colWidth / 2;

      doc.setTextColor(100, 100, 100);
      doc.setFontSize(7);
      doc.text("TOTAL PRICE", col1, boxY + 4, { align: "center" });
      doc.text("TOTAL WEIGHT", col2, boxY + 4, { align: "center" });
      doc.text("OPTIONS SELECTED", col3, boxY + 4, { align: "center" });

      doc.setTextColor(25, 55, 95);
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text(formatCurrency(config.TOTAL_COST_USD), col1, boxY + 13, { align: "center" });
      doc.text(formatWeight(config.TOTAL_WEIGHT_LBS), col2, boxY + 13, { align: "center" });
      doc.text(`${config.CONFIG_OPTIONS?.length || 0}`, col3, boxY + 13, { align: "center" });

      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(100, 100, 100);
      doc.text(`Base: ${formatCurrency(model.BASE_MSRP)}`, col1, boxY + 20, { align: "center" });
      doc.text(`Base: ${formatWeight(model.BASE_WEIGHT_LBS)}`, col2, boxY + 20, { align: "center" });
      
      yPos += 35;

      if (config.NOTES) {
        doc.setTextColor(80, 80, 80);
        doc.setFontSize(8);
        doc.setFont("helvetica", "italic");
        const noteLines = doc.splitTextToSize(`"${config.NOTES}"`, pageWidth - 2 * margin);
        doc.text(noteLines, pageWidth / 2, yPos, { align: "center" });
        yPos += noteLines.length * 4 + 6;
      }

      if (Object.keys(calculatedPerformanceScores).length > 0) {
        doc.setTextColor(25, 55, 95);
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.text("Performance Summary", margin, yPos);
        yPos += 7;

        const categories = Object.entries(calculatedPerformanceScores);
        const barWidth = (pageWidth - 2 * margin - 20) / categories.length;
        
        categories.forEach(([category, score], i) => {
          const x = margin + i * barWidth;
          const pct = Math.round(score * 20);
          
          doc.setFillColor(230, 230, 230);
          doc.rect(x, yPos, barWidth - 5, 6, "F");
          
          const fillWidth = ((barWidth - 5) * pct) / 100;
          doc.setFillColor(25, 55, 95);
          doc.rect(x, yPos, fillWidth, 6, "F");
          
          doc.setTextColor(60, 60, 60);
          doc.setFontSize(6);
          doc.setFont("helvetica", "normal");
          const labelX = x + (barWidth - 5) / 2;
          doc.text(category, labelX, yPos + 11, { align: "center" });
          doc.text(`${pct}%`, labelX, yPos + 15, { align: "center" });
        });
        yPos += 22;
      }

      doc.setDrawColor(200, 200, 200);
      doc.line(margin, yPos, pageWidth - margin, yPos);
      yPos += 8;

      doc.setTextColor(25, 55, 95);
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text("Bill of Materials - Selected Options", margin, yPos);
      yPos += 8;

      for (const system of reportData.bomHierarchy) {
        const hasSelectedItems = system.subsystems.some(ss => 
          ss.componentGroups.some(cg => cg.selectedItem)
        );
        if (!hasSelectedItems) continue;

        if (yPos > pageHeight - 50) {
          doc.addPage();
          yPos = margin;
        }

        doc.setFillColor(25, 55, 95);
        doc.rect(margin, yPos, pageWidth - 2 * margin, 8, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(9);
        doc.setFont("helvetica", "bold");
        doc.text(system.name.toUpperCase(), margin + 3, yPos + 5.5);
        
        const systemTotals = `${formatCurrency(system.totalCost)}  |  ${formatWeight(system.totalWeight)}`;
        doc.text(systemTotals, pageWidth - margin - 3, yPos + 5.5, { align: "right" });
        yPos += 12;

        const tableData: (string | { content: string; styles?: object })[][] = [];

        for (const subsystem of system.subsystems) {
          const hasItems = subsystem.componentGroups.some(cg => cg.selectedItem);
          if (!hasItems) continue;

          tableData.push([
            { content: `  ${subsystem.name}`, styles: { fontStyle: "bold", fillColor: [235, 238, 242] } },
            { content: "", styles: { fillColor: [235, 238, 242] } },
            { content: "", styles: { fillColor: [235, 238, 242] } },
            { content: "", styles: { fillColor: [235, 238, 242] } },
            { content: "", styles: { fillColor: [235, 238, 242] } },
            { content: "", styles: { fillColor: [235, 238, 242] } }
          ]);

          for (const cg of subsystem.componentGroups) {
            if (!cg.selectedItem) continue;
            const item = cg.selectedItem;
            
            tableData.push([
              `      ${cg.name}`,
              item.optionName,
              item.performanceCategory || "-",
              getStatusText(item.status),
              formatCurrency(item.cost),
              formatWeight(item.weight)
            ]);
          }
        }

        autoTable(doc, {
          startY: yPos,
          head: [["Component", "Selected Option", "Category", "Status", "Cost", "Weight"]],
          body: tableData,
          margin: { left: margin, right: margin },
          styles: {
            fontSize: 7,
            cellPadding: 2,
            halign: "center",
            valign: "middle",
          },
          headStyles: {
            fillColor: [220, 225, 230],
            textColor: [40, 40, 40],
            fontStyle: "bold",
            halign: "center",
          },
          columnStyles: {
            0: { cellWidth: 40, halign: "left" },
            1: { cellWidth: 45, halign: "center" },
            2: { cellWidth: 22, halign: "center" },
            3: { cellWidth: 22, halign: "center" },
            4: { cellWidth: 22, halign: "right" },
            5: { cellWidth: 22, halign: "right" },
          },
          didParseCell: (data) => {
            if (data.column.index === 3 && data.section === "body") {
              const status = data.cell.raw as string;
              if (status === "Upgraded") {
                data.cell.styles.textColor = [22, 163, 74];
                data.cell.styles.fontStyle = "bold";
              } else if (status === "Downgraded") {
                data.cell.styles.textColor = [217, 119, 6];
                data.cell.styles.fontStyle = "bold";
              } else if (status === "Default") {
                data.cell.styles.textColor = [37, 99, 235];
              }
            }
            if (data.column.index === 2 && data.section === "body") {
              const category = data.cell.raw as string;
              if (category === "Efficiency") data.cell.styles.textColor = [22, 163, 74];
              else if (category === "Safety") data.cell.styles.textColor = [37, 99, 235];
              else if (category === "Comfort") data.cell.styles.textColor = [147, 51, 234];
              else if (category === "Economy") data.cell.styles.textColor = [217, 119, 6];
              else if (category === "Power") data.cell.styles.textColor = [220, 38, 38];
              else if (category === "Durability") data.cell.styles.textColor = [100, 116, 139];
              else if (category === "Hauling") data.cell.styles.textColor = [234, 88, 12];
            }
          },
        });

        yPos = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
      }

      const totalPages = doc.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setTextColor(150, 150, 150);
        doc.setFontSize(7);
        doc.text(
          `Page ${i} of ${totalPages}`,
          pageWidth / 2,
          pageHeight - 8,
          { align: "center" }
        );
        doc.text(
          "Digital Twin Truck Configurator - Configuration Report",
          margin,
          pageHeight - 8
        );
      }

      const fileName = `${config.CONFIG_NAME.replace(/[^a-z0-9]/gi, "_")}_Report.pdf`;
      doc.save(fileName);
    } catch (err) {
      console.error("Error generating PDF:", err);
    } finally {
      setGeneratingPdf(false);
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-background rounded-xl p-8 flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading configuration details...</p>
        </div>
      </div>
    );
  }

  if (!reportData) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-background rounded-xl p-8">
          <p className="text-destructive">Failed to load report data</p>
          <button onClick={onClose} className="mt-4 px-4 py-2 bg-muted rounded-lg">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div 
        className="bg-background rounded-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b bg-gradient-to-r from-slate-800 to-slate-700 text-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FileText className="h-6 w-6" />
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-bold text-lg">{config.CONFIG_NAME}</h2>
                  {config.IS_VALIDATED && (
                    <div className="flex items-center gap-1 px-2 py-0.5 bg-green-500/20 rounded-full">
                      <ShieldCheck className="h-3.5 w-3.5 text-green-400" />
                      <span className="text-xs font-medium text-green-300">Validated</span>
                    </div>
                  )}
                </div>
                <p className="text-sm text-slate-300">{model.MODEL_NM} - Configuration Report</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={generatePDF}
                disabled={generatingPdf}
                className="flex items-center gap-2 px-4 py-2 bg-white text-slate-800 rounded-lg font-medium hover:bg-slate-100 transition-colors disabled:opacity-50"
              >
                {generatingPdf ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Export PDF
              </button>
              <button
                onClick={onClose}
                className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        <div className="p-4 bg-muted/50 border-b">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold">{formatCurrency(config.TOTAL_COST_USD)}</div>
              <div className="text-xs text-muted-foreground">Total Price (Base: {formatCurrency(model.BASE_MSRP)})</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{formatWeight(config.TOTAL_WEIGHT_LBS)}</div>
              <div className="text-xs text-muted-foreground">Total Weight (Base: {formatWeight(model.BASE_WEIGHT_LBS)})</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{config.CONFIG_OPTIONS?.length || 0}</div>
              <div className="text-xs text-muted-foreground">Options Selected</div>
            </div>
          </div>
          {config.NOTES && (
            <p className="mt-3 text-sm text-muted-foreground italic text-center">"{config.NOTES}"</p>
          )}
        </div>

        <div className="flex-1 overflow-auto p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-lg">Bill of Materials{showAllOptions ? " - All Options" : " - Selected Options"}</h3>
            <button
              onClick={() => setShowAllOptions(!showAllOptions)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-muted rounded-lg hover:bg-muted/80 transition-colors"
            >
              {showAllOptions ? "Show Selected Only" : "Show All Options"}
            </button>
          </div>
          
          <div className="space-y-3">
            {reportData.bomHierarchy.map(system => {
              const hasSelectedItems = system.subsystems.some(ss => 
                ss.componentGroups.some(cg => cg.selectedItem)
              );
              if (!hasSelectedItems && !showAllOptions) return null;
              
              return (
                <div key={system.name} className="border rounded-lg overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-700 text-white flex items-center justify-between">
                    <span className="font-semibold">{system.name}</span>
                    <span className="text-sm">
                      {formatCurrency(system.totalCost)} | {formatWeight(system.totalWeight)}
                    </span>
                  </div>
                  
                  <div className="divide-y">
                    {system.subsystems.map(subsystem => {
                      const hasItems = subsystem.componentGroups.some(cg => cg.selectedItem);
                      if (!hasItems && !showAllOptions) return null;
                      
                      return (
                        <div key={subsystem.name}>
                          <div className="px-4 py-2 bg-slate-100 flex items-center gap-2">
                            <ChevronRight className="h-4 w-4 text-slate-400" />
                            <span className="font-medium text-slate-700">{subsystem.name}</span>
                          </div>
                          
                          <div className="divide-y divide-slate-100">
                            {subsystem.componentGroups.map(cg => {
                              const itemsToShow = showAllOptions ? cg.items : (cg.selectedItem ? [cg.selectedItem] : []);
                              if (itemsToShow.length === 0) return null;
                              
                              return (
                                <div key={cg.name}>
                                  {showAllOptions && (
                                    <div className="px-4 py-1.5 pl-8 bg-slate-50 text-xs font-medium text-slate-500">
                                      {cg.name}
                                    </div>
                                  )}
                                  {itemsToShow.map(item => (
                                    <div 
                                      key={item.optionId}
                                      className={cn(
                                        "px-4 py-2.5 pl-10 flex items-center justify-between text-sm",
                                        item.isSelected ? "bg-blue-50/50" : "hover:bg-slate-50",
                                        !item.isSelected && "opacity-60"
                                      )}
                                    >
                                      <div className="flex items-center gap-3 flex-1 min-w-0">
                                        <ChevronRight className="h-3 w-3 text-slate-300 flex-shrink-0" />
                                        {!showAllOptions && <span className="text-slate-500 w-36 flex-shrink-0">{cg.name}</span>}
                                        {item.isSelected && <Check className="h-4 w-4 text-green-600 flex-shrink-0" />}
                                        <span className={cn("font-medium truncate", item.isSelected ? "" : "text-slate-500")}>{item.optionName}</span>
                                        {getStatusBadge(item.status)}
                                        <span className={cn(
                                          "px-1.5 py-0.5 text-[10px] rounded",
                                          item.performanceCategory === 'Efficiency' ? "bg-green-100 text-green-700" :
                                          item.performanceCategory === 'Safety' ? "bg-blue-100 text-blue-700" :
                                          item.performanceCategory === 'Comfort' ? "bg-purple-100 text-purple-700" :
                                          item.performanceCategory === 'Economy' ? "bg-amber-100 text-amber-700" :
                                          item.performanceCategory === 'Power' ? "bg-red-100 text-red-700" :
                                          item.performanceCategory === 'Durability' ? "bg-slate-100 text-slate-700" :
                                          item.performanceCategory === 'Hauling' ? "bg-orange-100 text-orange-700" :
                                          "bg-gray-100 text-gray-700"
                                        )}>
                                          {item.performanceCategory}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-4 text-sm flex-shrink-0">
                                        <span className={cn(
                                          "w-20 text-right font-medium",
                                          item.cost === 0 ? "text-green-600" : ""
                                        )}>
                                          {item.cost === 0 ? "Included" : formatCurrency(item.cost)}
                                        </span>
                                        <span className="text-muted-foreground w-20 text-right">
                                          {formatWeight(item.weight)}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
