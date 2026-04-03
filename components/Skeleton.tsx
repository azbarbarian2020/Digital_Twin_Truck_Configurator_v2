"use client";

import { cn } from "@/lib/utils";

export function ModelCardSkeleton() {
  return (
    <div className="bg-card border rounded-xl overflow-hidden animate-pulse">
      <div className="h-48 bg-muted" />
      <div className="p-6">
        <div className="h-6 bg-muted rounded w-3/4 mb-3" />
        <div className="h-4 bg-muted rounded w-full mb-2" />
        <div className="h-4 bg-muted rounded w-2/3 mb-4" />
        <div className="flex justify-between items-center">
          <div className="h-8 bg-muted rounded w-24" />
          <div className="h-10 bg-muted rounded w-28" />
        </div>
      </div>
    </div>
  );
}

export function ModelSelectionSkeleton() {
  return (
    <div className="container max-w-7xl mx-auto px-4 py-12">
      <div className="text-center mb-12">
        <div className="h-10 bg-muted rounded w-80 mx-auto mb-4 animate-pulse" />
        <div className="h-5 bg-muted rounded w-96 mx-auto animate-pulse" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {[1, 2, 3, 4, 5].map(i => (
          <ModelCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function OptionCardSkeleton() {
  return (
    <div className="p-4 rounded-lg border-2 border-transparent bg-muted/30 animate-pulse">
      <div className="flex items-start justify-between mb-2">
        <div className="h-5 bg-muted rounded w-32" />
      </div>
      <div className="h-4 bg-muted rounded w-full mb-2" />
      <div className="h-4 bg-muted rounded w-2/3 mb-3" />
      <div className="flex justify-between">
        <div className="h-5 bg-muted rounded w-20" />
        <div className="h-4 bg-muted rounded w-16" />
      </div>
    </div>
  );
}

export function ConfiguratorSkeleton() {
  return (
    <div className="flex h-[calc(100vh-4rem)]">
      <div className="flex-1 overflow-auto p-6">
        <div className="flex gap-2 mb-6 flex-wrap">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
            <div key={i} className="h-10 w-24 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
        <div className="flex gap-6">
          <div className="w-48 shrink-0 space-y-2">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-10 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="flex-1 space-y-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="border rounded-lg overflow-hidden">
                <div className="h-12 bg-muted/50 animate-pulse" />
                <div className="p-4 grid grid-cols-3 gap-3">
                  <OptionCardSkeleton />
                  <OptionCardSkeleton />
                  <OptionCardSkeleton />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <aside className="w-80 border-l bg-muted/30 p-6">
        <div className="space-y-6">
          <div className="text-center pb-6 border-b">
            <div className="w-40 h-28 mx-auto mb-4 bg-muted rounded-xl animate-pulse" />
            <div className="h-6 bg-muted rounded w-48 mx-auto animate-pulse" />
          </div>
          <div>
            <div className="h-4 bg-muted rounded w-20 mb-2 animate-pulse" />
            <div className="h-10 bg-muted rounded w-40 animate-pulse" />
          </div>
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i}>
                <div className="h-4 bg-muted rounded w-24 mb-1 animate-pulse" />
                <div className="h-3 bg-muted rounded-full animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

export function SavedConfigSkeleton() {
  return (
    <div className="border rounded-xl p-6 animate-pulse">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="h-6 bg-muted rounded w-48 mb-2" />
          <div className="h-4 bg-muted rounded w-32" />
        </div>
        <div className="h-8 bg-muted rounded w-20" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="h-16 bg-muted rounded" />
        <div className="h-16 bg-muted rounded" />
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("bg-muted rounded animate-pulse", className)} />
  );
}
