"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { 
  foldersApi,
  type Folder,
} from "@/lib/api";

function CourseMaterialContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderPath, setFolderPath] = useState<Folder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialPathRestored, setInitialPathRestored] = useState(false);

  const currentFolder = folderPath.length > 0 ? folderPath[folderPath.length - 1] : null;
  const userId = session?.user?.id;

  // Form states
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isAddingMaterial, setIsAddingMaterial] = useState(false);
  const [newMaterialName, setNewMaterialName] = useState("");
  const [newMaterialDescription, setNewMaterialDescription] = useState("");

  // Load folders on mount
  useEffect(() => {
    if (userId) {
      loadFolders();
    }
  }, [userId]);

  // Restore folder path from URL params after folders are loaded
  useEffect(() => {
    if (folders.length > 0 && !initialPathRestored) {
      const foldersParam = searchParams.get('folders');
      if (foldersParam) {
        const folderIds = foldersParam.split(',');
        const path = buildFolderPath(folders, folderIds);
        if (path.length > 0) {
          setFolderPath(path);
        }
        // Clear the URL params after restoring
        router.replace('/course-material', { scroll: false });
      }
      setInitialPathRestored(true);
    }
  }, [folders, searchParams, initialPathRestored, router]);

  // Helper to build folder path from IDs
  const buildFolderPath = (folderList: Folder[], folderIds: string[]): Folder[] => {
    const path: Folder[] = [];
    let currentList = folderList;
    
    for (const id of folderIds) {
      const folder = currentList.find(f => f.id === id);
      if (folder) {
        path.push(folder);
        currentList = folder.subfolders;
      } else {
        break;
      }
    }
    
    return path;
  };

  const loadFolders = async () => {
    if (!userId) return;
    try {
      setIsLoading(true);
      const loadedFolders = await foldersApi.list(userId);
      setFolders(loadedFolders);
    } catch (err) {
      console.error('Failed to load folders:', err);
      setError('Failed to load folders');
    } finally {
      setIsLoading(false);
    }
  };

  // Helper to update nested folder structure
  const updateFolderAtPath = (
    folderList: Folder[],
    path: Folder[],
    updateFn: (folder: Folder) => Folder
  ): Folder[] => {
    if (path.length === 0) return folderList;
    
    const [current, ...rest] = path;
    
    return folderList.map((folder) => {
      if (folder.id === current.id) {
        if (rest.length === 0) {
          return updateFn(folder);
        } else {
          return {
            ...folder,
            subfolders: updateFolderAtPath(folder.subfolders, rest, updateFn),
          };
        }
      }
      return folder;
    });
  };

  // Folder actions
  const handleAddFolder = async () => {
    if (!newFolderName.trim() || !userId) return;

    try {
      setIsLoading(true);
      const newFolder = await foldersApi.create(newFolderName.trim(), userId);
      setFolders((prev) => [...prev, newFolder]);
      setNewFolderName("");
      setIsAddingFolder(false);
    } catch (err) {
      console.error('Failed to create folder:', err);
      setError('Failed to create folder');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddSubfolder = async () => {
    if (!newFolderName.trim() || !currentFolder || !userId) return;

    try {
      setIsLoading(true);
      const newSubfolder = await foldersApi.create(newFolderName.trim(), userId, currentFolder.id);
      
      setFolders((prev) =>
        updateFolderAtPath(prev, folderPath, (folder) => ({
          ...folder,
          subfolders: [...folder.subfolders, newSubfolder],
        }))
      );
      
      setFolderPath((prev) => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            subfolders: [...updated[updated.length - 1].subfolders, newSubfolder],
          };
        }
        return updated;
      });
      
      setNewFolderName("");
      setIsAddingFolder(false);
    } catch (err) {
      console.error('Failed to create subfolder:', err);
      setError('Failed to create subfolder');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    try {
      await foldersApi.delete(folderId);
      setFolders((prev) => prev.filter((f) => f.id !== folderId));
    } catch (err) {
      console.error('Failed to delete folder:', err);
      setError('Failed to delete folder');
    }
  };

  const handleDeleteSubfolder = async (subfolderId: string) => {
    if (!currentFolder) return;

    try {
      await foldersApi.delete(subfolderId);
      
      setFolders((prev) =>
        updateFolderAtPath(prev, folderPath, (folder) => ({
          ...folder,
          subfolders: folder.subfolders.filter((sf) => sf.id !== subfolderId),
        }))
      );
      
      setFolderPath((prev) => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            subfolders: updated[updated.length - 1].subfolders.filter((sf) => sf.id !== subfolderId),
          };
        }
        return updated;
      });
    } catch (err) {
      console.error('Failed to delete subfolder:', err);
      setError('Failed to delete subfolder');
    }
  };

  // Material actions
  const handleAddMaterial = async () => {
    if (!newMaterialName.trim() || !currentFolder) return;

    try {
      setIsLoading(true);
      const newSection = await foldersApi.createFolderSection(
        currentFolder.id,
        newMaterialName.trim(),
        newMaterialDescription.trim() || "Material",
        'custom'
      );
      
      setFolders((prev) =>
        updateFolderAtPath(prev, folderPath, (folder) => ({
          ...folder,
          sections: [...folder.sections, newSection],
        }))
      );
      
      setFolderPath((prev) => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            sections: [...updated[updated.length - 1].sections, newSection],
          };
        }
        return updated;
      });
      
      setNewMaterialName("");
      setNewMaterialDescription("");
      setIsAddingMaterial(false);
    } catch (err) {
      console.error('Failed to create material:', err);
      setError('Failed to create material');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteMaterial = async (sectionId: string) => {
    if (!currentFolder) return;

    try {
      await foldersApi.deleteSection(sectionId);

      setFolders((prev) =>
        updateFolderAtPath(prev, folderPath, (folder) => ({
          ...folder,
          sections: folder.sections.filter((s) => s.id !== sectionId),
        }))
      );
      
      setFolderPath((prev) => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            sections: updated[updated.length - 1].sections.filter((s) => s.id !== sectionId),
          };
        }
        return updated;
      });
    } catch (err) {
      console.error('Failed to delete material:', err);
      setError('Failed to delete material');
    }
  };

  // Navigate to preview page with folder context
  const handleNavigateToPreview = (sectionId: string) => {
    // Pass the current folder path as query params so we can navigate back correctly
    const folderIds = folderPath.map(f => f.id).join(',');
    const url = folderIds 
      ? `/course-material/preview/${sectionId}?folders=${folderIds}`
      : `/course-material/preview/${sectionId}`;
    router.push(url);
  };

  // Navigation
  const handleBackToFolders = () => {
    setFolderPath([]);
  };

  const handleNavigateToPathIndex = (index: number) => {
    if (index < 0) {
      handleBackToFolders();
    } else {
      setFolderPath((prev) => prev.slice(0, index + 1));
    }
  };

  const handleEnterSubfolder = (subfolder: Folder) => {
    setFolderPath((prev) => [...prev, subfolder]);
  };

  // Count files in folder (including subfolders)
  const countFilesInFolder = (folder: Folder): number => {
    let count = folder.sections.reduce((acc, s) => acc + s.files.length, 0);
    count += folder.subfolders.reduce((acc, sf) => acc + countFilesInFolder(sf), 0);
    return count;
  };

  // Render breadcrumb
  const renderBreadcrumb = () => (
    <div className="flex items-center gap-2 text-sm mb-6 flex-wrap">
      <button
        onClick={handleBackToFolders}
        className={`transition ${
          folderPath.length === 0
            ? "text-white font-semibold"
            : "text-slate-400 hover:text-white cursor-pointer"
        }`}
      >
        Folders
      </button>
      {folderPath.map((folder, index) => (
        <span key={folder.id} className="flex items-center gap-2">
          <span className="text-slate-600">/</span>
          <button
            onClick={() => {
              if (index < folderPath.length - 1) {
                handleNavigateToPathIndex(index);
              }
            }}
            className={`transition ${
              index === folderPath.length - 1
                ? "text-white font-semibold"
                : "text-slate-400 hover:text-white cursor-pointer"
            }`}
          >
            {folder.name}
          </button>
        </span>
      ))}
    </div>
  );

  // Render folders view (root level)
  const renderFoldersView = () => (
    <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {folders.map((folder) => {
        const materialCount = folder.sections.length;
        
        return (
          <div
            key={folder.id}
            role="button"
            tabIndex={0}
            onClick={() => setFolderPath([folder])}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setFolderPath([folder]);
              }
            }}
            className="group relative flex flex-col items-center justify-center border border-slate-800 bg-black p-6 h-[220px] transition hover:border-slate-600 hover:bg-slate-900/50 cursor-pointer text-left"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteFolder(folder.id);
              }}
              className="absolute top-3 right-3 text-slate-600 hover:text-red-400 transition opacity-0 group-hover:opacity-100 cursor-pointer"
              title="Delete folder"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-amber-500 mb-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
            </svg>
            <span className="text-white font-semibold text-center">{folder.name}</span>
            <span className="text-slate-500 text-xs mt-1">
              {folder.subfolders.length > 0 && (
                <>{folder.subfolders.length} folder{folder.subfolders.length !== 1 ? "s" : ""}{materialCount > 0 && ", "}</>
              )}
              {materialCount > 0 && (
                <>{materialCount} material{materialCount !== 1 ? "s" : ""}</>
              )}
              {folder.subfolders.length === 0 && materialCount === 0 && "Empty"}
            </span>
          </div>
        );
      })}

      {/* Add Folder Card */}
      <div className="h-[220px]">
        {!isAddingFolder ? (
          <button
            onClick={() => setIsAddingFolder(true)}
            className="flex h-full w-full flex-col items-center justify-center text-slate-500 hover:text-slate-300 border border-slate-800 border-dashed bg-black hover:border-slate-600 hover:bg-slate-900/50 transition cursor-pointer p-6"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
            </svg>
            <span className="text-sm font-semibold">Add Folder</span>
            <span className="mt-1 text-xs">Organize your materials</span>
          </button>
        ) : (
          <div className="flex h-full flex-col justify-between border border-slate-800 bg-black p-5">
            <div>
              <h3 className="text-base font-semibold text-white">New Folder</h3>
            </div>
            <div className="flex flex-col justify-center">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newFolderName.trim()) {
                    handleAddFolder();
                  } else if (e.key === "Escape") {
                    setIsAddingFolder(false);
                    setNewFolderName("");
                  }
                }}
                placeholder="e.g., Fall 2025, Math 101"
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-white focus:outline-none focus:ring-1 focus:ring-white"
                autoFocus
              />
            </div>
            <div className="flex gap-2 mt-2">
              <button
                onClick={handleAddFolder}
                disabled={!newFolderName.trim()}
                className="flex-1 bg-white border border-white px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-black transition hover:bg-black hover:text-white disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setIsAddingFolder(false);
                  setNewFolderName("");
                }}
                className="flex-1 border border-white px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-white transition hover:bg-white hover:text-black cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );

  // Render folder contents view (subfolders and materials)
  const renderFolderContentsView = () => {
    if (!currentFolder) return null;

    return (
      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {/* Render subfolders first */}
        {currentFolder.subfolders.map((subfolder) => {
          const materialCount = subfolder.sections.length;
          
          return (
            <div
              key={subfolder.id}
              role="button"
              tabIndex={0}
              onClick={() => handleEnterSubfolder(subfolder)}
              className="group relative flex flex-col items-center justify-center border border-slate-800 bg-black p-6 h-[220px] transition hover:border-slate-600 hover:bg-slate-900/50 cursor-pointer text-left"
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteSubfolder(subfolder.id);
                }}
                className="absolute top-3 right-3 text-slate-600 hover:text-red-400 transition opacity-0 group-hover:opacity-100 cursor-pointer"
                title="Delete folder"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-amber-500 mb-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
              </svg>
              <span className="text-white font-semibold text-center">{subfolder.name}</span>
              <span className="text-slate-500 text-xs mt-1">
                {subfolder.subfolders.length > 0 && (
                  <>{subfolder.subfolders.length} folder{subfolder.subfolders.length !== 1 ? "s" : ""}{materialCount > 0 && ", "}</>
                )}
                {materialCount > 0 && (
                  <>{materialCount} material{materialCount !== 1 ? "s" : ""}</>
                )}
                {subfolder.subfolders.length === 0 && materialCount === 0 && "Empty"}
              </span>
            </div>
          );
        })}

        {/* Render materials */}
        {currentFolder.sections.map((material) => (
          <div
            key={material.id}
            role="button"
            tabIndex={0}
            onClick={() => handleNavigateToPreview(material.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleNavigateToPreview(material.id);
              }
            }}
            className="group relative flex flex-col border border-slate-800 bg-black p-4 h-[220px] cursor-pointer transition hover:border-slate-600 hover:bg-slate-900/50"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteMaterial(material.id);
              }}
              className="absolute top-3 right-3 text-slate-600 hover:text-red-400 transition opacity-0 group-hover:opacity-100 cursor-pointer"
              title="Delete material"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <div className="flex-shrink-0">
              <h3 className="text-lg font-semibold text-white pr-6">{material.title}</h3>
              <p className="mt-0.5 text-sm text-slate-400 line-clamp-1">{material.description}</p>
            </div>
            <div className="mt-2 flex-1 overflow-hidden">
              {material.files.length === 0 ? (
                <p className="text-sm text-slate-500 italic">No files yet</p>
              ) : (
                <div className="space-y-1">
                  {material.files.slice(0, 2).map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center justify-between bg-slate-800/50 px-2 py-1 ring-1 ring-slate-700"
                    >
                      <span className="text-sm text-slate-300 truncate flex-1">{file.name}</span>
                    </div>
                  ))}
                  {material.files.length > 2 && (
                    <p className="text-sm text-slate-500">+{material.files.length - 2} more</p>
                  )}
                </div>
              )}
            </div>
            <div className="flex-shrink-0 mt-2 flex gap-2">
              <span className="flex-1 inline-flex items-center justify-center bg-slate-800 border border-slate-600 px-2 py-1.5 text-xs font-medium text-slate-300">
                {material.files.length} file{material.files.length !== 1 ? 's' : ''}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleNavigateToPreview(material.id);
                }}
                className="inline-flex cursor-pointer items-center justify-center bg-white border border-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-black transition hover:bg-black hover:text-white"
              >
                Open
              </button>
            </div>
          </div>
        ))}

        {/* Add Subfolder Card */}
        <div className="h-[220px]">
          {!isAddingFolder ? (
            <button
              onClick={() => setIsAddingFolder(true)}
              className="flex h-full w-full flex-col items-center justify-center text-slate-500 hover:text-slate-300 border border-slate-800 border-dashed bg-black hover:border-slate-600 hover:bg-slate-900/50 transition cursor-pointer p-6"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 mb-2 text-amber-500/70" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
              </svg>
              <span className="text-sm font-semibold">Add Folder</span>
              <span className="mt-1 text-xs">Create a subfolder</span>
            </button>
          ) : (
            <div className="flex h-full flex-col justify-between border border-slate-800 bg-black p-5">
              <div>
                <h3 className="text-base font-semibold text-white">New Folder</h3>
              </div>
              <div className="flex flex-col justify-center">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newFolderName.trim()) {
                      handleAddSubfolder();
                    } else if (e.key === "Escape") {
                      setIsAddingFolder(false);
                      setNewFolderName("");
                    }
                  }}
                  placeholder="e.g., Midterm, Final Project"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-white focus:outline-none focus:ring-1 focus:ring-white"
                  autoFocus
                />
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleAddSubfolder}
                  disabled={!newFolderName.trim()}
                  className="flex-1 bg-white border border-white px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-black transition hover:bg-black hover:text-white disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  Create
                </button>
                <button
                  onClick={() => {
                    setIsAddingFolder(false);
                    setNewFolderName("");
                  }}
                  className="flex-1 border border-white px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-white transition hover:bg-white hover:text-black cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Add Material Card */}
        <div className="h-[220px]">
          {!isAddingMaterial ? (
            <button
              onClick={() => setIsAddingMaterial(true)}
              className="flex h-full w-full flex-col items-center justify-center text-slate-500 hover:text-slate-300 border border-slate-800 border-dashed bg-black hover:border-slate-600 hover:bg-slate-900/50 transition cursor-pointer p-6"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              <span className="text-sm font-semibold">Add Material</span>
              <span className="mt-1 text-xs">Create a material category</span>
            </button>
          ) : (
            <div className="flex h-full flex-col justify-between border border-slate-800 bg-black p-5">
              <div>
                <h3 className="text-base font-semibold text-white">New Material</h3>
              </div>
              <div className="flex flex-col gap-3">
                <input
                  type="text"
                  value={newMaterialName}
                  onChange={(e) => setNewMaterialName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newMaterialName.trim()) {
                      handleAddMaterial();
                    } else if (e.key === "Escape") {
                      setIsAddingMaterial(false);
                      setNewMaterialName("");
                      setNewMaterialDescription("");
                    }
                  }}
                  placeholder="e.g., Textbooks, Lecture Notes"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-white focus:outline-none focus:ring-1 focus:ring-white"
                  autoFocus
                />
                <input
                  type="text"
                  value={newMaterialDescription}
                  onChange={(e) => setNewMaterialDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newMaterialName.trim()) {
                      handleAddMaterial();
                    } else if (e.key === "Escape") {
                      setIsAddingMaterial(false);
                      setNewMaterialName("");
                      setNewMaterialDescription("");
                    }
                  }}
                  placeholder="Description (optional)"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-white focus:outline-none focus:ring-1 focus:ring-white"
                />
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleAddMaterial}
                  disabled={!newMaterialName.trim()}
                  className="flex-1 bg-white border border-white px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-black transition hover:bg-black hover:text-white disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  Create
                </button>
                <button
                  onClick={() => {
                    setIsAddingMaterial(false);
                    setNewMaterialName("");
                    setNewMaterialDescription("");
                  }}
                  className="flex-1 border border-white px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-white transition hover:bg-white hover:text-black cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    );
  };

  // Get header content
  const getHeaderContent = () => {
    if (currentFolder) {
      return {
        label: "Course Material",
        title: `${currentFolder.name} - Add folders or materials`,
      };
    }
    return {
      label: "Course Material",
      title: "Create folders to organize your materials",
    };
  };

  const header = getHeaderContent();

  return (
    <div className="h-full overflow-hidden -mt-4">
      {/* Error message */}
      {error && (
        <div className="mb-4 bg-red-900/30 border border-red-500 px-4 py-3 text-red-300 flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">×</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
            {header.label}
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-white">
            {header.title}
          </h1>
        </div>
        {folderPath.length > 0 && (
          <div className="flex gap-3">
            {/* Back button */}
            <button
              onClick={() => {
                if (folderPath.length === 1) {
                  setFolderPath([]);
                } else {
                  setFolderPath((prev) => prev.slice(0, -1));
                }
              }}
              className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              {folderPath.length === 1 
                ? "Back to Folders" 
                : folderPath[folderPath.length - 2]?.name}
            </button>
            
            {/* Root folders button - only shown when in subfolder */}
            {folderPath.length > 1 && (
              <button
                onClick={() => setFolderPath([])}
                className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
                </svg>
                Folders
              </button>
            )}
          </div>
        )}
      </div>

      {renderBreadcrumb()}

      {folderPath.length === 0 && renderFoldersView()}
      {currentFolder && renderFolderContentsView()}
    </div>
  );
}

export default function CourseMaterialPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    }>
      <CourseMaterialContent />
    </Suspense>
  );
}
