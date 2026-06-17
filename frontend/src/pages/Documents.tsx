import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, FolderOpen, Search, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Loading } from '../components/ui';
import { fileDropHandlers } from '../lib/fileDrop';
import { formatEasternDateTime } from '../lib/time';

interface ProjectDocument {
  id: string;
  project_id: string;
  original_name: string;
  mime_type: string;
  size: number;
  document_type?: string | null;
  uploaded_by_name?: string | null;
  created_at: string;
}

interface DocumentProject {
  id: string;
  address: string;
  job_name: string;
  status: string;
  documents: ProjectDocument[];
}

const fileSize = (bytes: number) => {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(Math.round(bytes / 1024), 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (value: string) => {
  return formatEasternDateTime(value, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export default function Documents() {
  const [projects, setProjects] = useState<DocumentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [uploadingProjectId, setUploadingProjectId] = useState<string | null>(null);

  const loadDocuments = async () => {
    const res = await api.get('/documents');
    setProjects(Array.isArray(res.data?.projects) ? res.data.projects : []);
  };

  useEffect(() => {
    loadDocuments()
      .catch(() => toast.error('Failed to load documents'))
      .finally(() => setLoading(false));
  }, []);

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(project => {
      const docText = project.documents.map(doc => `${doc.original_name} ${doc.document_type || ''}`).join(' ');
      return `${project.address} ${project.job_name} ${docText}`.toLowerCase().includes(q);
    });
  }, [projects, query]);

  const uploadDocuments = async (projectId: string, files: FileList | File[] | null) => {
    const uploadFiles = Array.from(files || []);
    if (uploadFiles.length === 0) return;
    setUploadingProjectId(projectId);
    try {
      const formData = new FormData();
      uploadFiles.forEach(file => formData.append('documents', file));
      await api.post(`/documents/${projectId}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(uploadFiles.length === 1 ? 'Document uploaded' : 'Documents uploaded');
      await loadDocuments();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload document');
    } finally {
      setUploadingProjectId(null);
    }
  };

  const deleteDocument = async (projectId: string, documentId: string) => {
    if (!confirm('Delete this document?')) return;
    try {
      await api.delete(`/documents/${projectId}/${documentId}`);
      toast.success('Document deleted');
      await loadDocuments();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete document');
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="min-h-full px-6 py-6 md:px-8" style={{ background: '#F0F2F5' }}>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Documents</h1>
            <p className="text-sm text-gray-500 mt-1">Organized by project address</p>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl w-full xl:w-[460px]"
            style={{ background: 'white', border: '1px solid #D1D5DB', boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}
          >
            <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search address, job, or document"
              className="w-full bg-transparent text-sm outline-none text-gray-900 placeholder:text-gray-500"
            />
          </div>
        </div>

        <div className="space-y-4">
          {filteredProjects.length === 0 ? (
            <div className="rounded-2xl p-12 text-center" style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
              <FolderOpen className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-bold text-gray-500">No projects or documents match this search</p>
            </div>
          ) : filteredProjects.map(project => (
            <div key={project.id} className="rounded-2xl overflow-hidden" style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
              <div className="p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-gray-100">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-amber-600 flex-shrink-0" />
                    <h2 className="text-base font-black text-gray-900 truncate">{project.address}</h2>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{project.job_name}</p>
                </div>
                <label
                  className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-black text-white bg-gray-900 hover:bg-gray-800 cursor-pointer"
                  {...fileDropHandlers(files => uploadDocuments(project.id, files), {
                    disabled: uploadingProjectId === project.id,
                    multiple: true,
                  })}
                >
                  <Upload className="w-3.5 h-3.5" />
                  {uploadingProjectId === project.id ? 'Uploading...' : 'Upload'}
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    disabled={uploadingProjectId === project.id}
                    onChange={event => {
                      uploadDocuments(project.id, event.target.files);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>

              <div className="divide-y divide-gray-100">
                {project.documents.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-gray-400">No documents uploaded for this project yet</div>
                ) : project.documents.map(doc => (
                  <div key={doc.id} className="px-5 py-4 flex flex-col md:flex-row md:items-center gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center flex-shrink-0">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-black text-gray-900 truncate">{doc.original_name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {fileSize(doc.size)} · Uploaded {formatDate(doc.created_at)}
                          {doc.uploaded_by_name ? ` by ${doc.uploaded_by_name}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <a
                        href={`/api/documents/${project.id}/${doc.id}/download`}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black bg-blue-50 text-blue-700 border border-blue-100"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download
                      </a>
                      <button
                        type="button"
                        onClick={() => deleteDocument(project.id, doc.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black bg-red-50 text-red-700 border border-red-100"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
