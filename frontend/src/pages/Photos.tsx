import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { Loading } from '../components/ui';
import { Camera, Search, Grid, List } from 'lucide-react';
import { format } from 'date-fns';

interface Photo {
  id: string;
  filename: string;
  original_name: string;
  caption: string;
  uploader_name: string;
  category_name: string;
  created_at: string;
  project_id: string;
  project_address?: string;
}

export default function Photos() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const projRes = await api.get('/projects');
        setProjects(projRes.data);

        const allPhotos: Photo[] = [];
        const projectsToLoad = selectedProject
          ? projRes.data.filter((p: any) => p.id === selectedProject)
          : projRes.data;

        for (const proj of projectsToLoad) {
          try {
            const res = await api.get(`/projects/${proj.id}/photos`);
            res.data.forEach((photo: Photo) => {
              allPhotos.push({ ...photo, project_address: proj.address });
            });
          } catch (err) {}
        }
        setPhotos(allPhotos.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [selectedProject]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Progress Photos</h1>
          <p className="text-sm text-gray-500 mt-0.5">{photos.length} photos</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setView('grid')} className={`p-2 rounded-lg transition-colors ${view === 'grid' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
            <Grid className="w-4 h-4" />
          </button>
          <button onClick={() => setView('list')} className={`p-2 rounded-lg transition-colors ${view === 'list' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter by project */}
      <div className="mb-5">
        <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)} className="w-full sm:w-auto px-3.5 py-2.5 rounded-xl border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.address}</option>)}
        </select>
      </div>

      {loading ? <Loading /> : (
        photos.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <Camera className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No photos yet</p>
            <p className="text-gray-400 text-sm mt-1">Upload photos from any project page</p>
          </div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {photos.map(photo => (
              <div
                key={photo.id}
                className="relative group aspect-square rounded-xl overflow-hidden bg-gray-100 cursor-pointer"
                onClick={() => setLightbox(`/uploads/${photo.project_id}/${photo.filename}`)}
              >
                <img
                  src={`/uploads/${photo.project_id}/${photo.filename}`}
                  alt={photo.original_name}
                  className="w-full h-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="absolute bottom-0 left-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <p className="text-white text-xs font-medium truncate">{photo.project_address}</p>
                  {photo.category_name && <p className="text-white/70 text-xs truncate">{photo.category_name}</p>}
                  <p className="text-white/60 text-xs">{format(new Date(photo.created_at), 'MMM d, yyyy')}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {photos.map(photo => (
              <div key={photo.id} className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
                <div
                  className="w-16 h-16 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0 cursor-pointer"
                  onClick={() => setLightbox(`/uploads/${photo.project_id}/${photo.filename}`)}
                >
                  <img src={`/uploads/${photo.project_id}/${photo.filename}`} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{photo.project_address}</p>
                  <p className="text-xs text-gray-500">{photo.category_name || 'Uncategorized'} · {photo.uploader_name}</p>
                  {photo.caption && <p className="text-xs text-gray-400 truncate">{photo.caption}</p>}
                  <p className="text-xs text-gray-400">{format(new Date(photo.created_at), 'MMM d, yyyy h:mm a')}</p>
                </div>
                <Link to={`/projects/${photo.project_id}`} className="text-xs text-blue-600 hover:underline flex-shrink-0">View Project</Link>
              </div>
            ))}
          </div>
        )
      )}

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" className="max-w-full max-h-full object-contain rounded-lg" />
          <button className="absolute top-4 right-4 text-white/70 hover:text-white" onClick={() => setLightbox(null)}>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
