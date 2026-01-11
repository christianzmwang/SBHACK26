"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useSession } from "next-auth/react";
import { foldersApi, practiceApi, type Folder, type PracticeOverview } from "@/lib/api";

interface DataContextType {
  folders: Folder[];
  practiceOverview: PracticeOverview | null;
  isLoadingFolders: boolean;
  isLoadingOverview: boolean;
  foldersError: string | null;
  overviewError: string | null;
  refreshFolders: () => Promise<void>;
  refreshPracticeOverview: () => Promise<void>;
  updateFoldersCache: (folders: Folder[]) => void;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

export function DataProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const userId = session?.user?.id;

  const [folders, setFolders] = useState<Folder[]>([]);
  const [practiceOverview, setPracticeOverview] = useState<PracticeOverview | null>(null);
  
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [isLoadingOverview, setIsLoadingOverview] = useState(false);
  
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const updateFoldersCache = useCallback((newFolders: Folder[]) => {
    setFolders(newFolders);
  }, []);

  const refreshFolders = useCallback(async () => {
    if (!userId) return;
    try {
      setIsLoadingFolders(true);
      const data = await foldersApi.list(userId);
      setFolders(data);
      setFoldersError(null);
    } catch (err) {
      console.error("Failed to load folders:", err);
      setFoldersError("Failed to load folders");
    } finally {
      setIsLoadingFolders(false);
    }
  }, [userId]);

  const refreshPracticeOverview = useCallback(async () => {
    if (!userId) return;
    try {
      setIsLoadingOverview(true);
      const data = await practiceApi.getOverview(userId);
      setPracticeOverview(data);
      setOverviewError(null);
    } catch (err) {
      console.error("Failed to load practice overview:", err);
      setOverviewError("Failed to load practice data");
    } finally {
      setIsLoadingOverview(false);
    }
  }, [userId]);

  // Initial load when user is authenticated
  useEffect(() => {
    if (status === "authenticated" && userId) {
      // Load both in parallel
      if (folders.length === 0) refreshFolders();
      if (!practiceOverview) refreshPracticeOverview();
    }
  }, [status, userId, refreshFolders, refreshPracticeOverview]);

  return (
    <DataContext.Provider
      value={{
        folders,
        practiceOverview,
        isLoadingFolders,
        isLoadingOverview,
        foldersError,
        overviewError,
        refreshFolders,
        refreshPracticeOverview,
        updateFoldersCache,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const context = useContext(DataContext);
  if (context === undefined) {
    throw new Error("useData must be used within a DataProvider");
  }
  return context;
}
