import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { Loading, StatusBadge } from '../components/ui';
import { ClipboardList, Search, Filter } from 'lucide-react';
import { format } from 'date-fns';
import { useAuthStore } from '../store/authStore';

interface PunchItem {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigned_to_name: string;
  due_date: string;
  project_id: string;
  project_address?: string;
  created_at: string;
  photo_count: number;
}

export default function PunchList() {
  const { user } = useAuthStore();
  const [items, setItems] = useState<PunchItem[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const projRes = await api.get('/projects');
        setProjects(projRes.data);

        // Load punch list items from all projects
        const allItems: PunchItem[] = [];
        for (const proj of projRes.data) {
          try {
            const params = new URLSearchParams();
            if (statusFilter) params.set('status', statusFilter);
            if (priorityFilter) params.set('priority', priorityFilter);
            if (search) params.set('search', search);
            const res = await api.get(`/projects/${proj.id}/punch-list?${params}`);
            res.data.forEach((item: PunchItem) => {
              allItems.push({ ...item, project_address: proj.address });
            });
          } catch (err) {}
        }
        setItems(allItems);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [statusFilter, priorityFilter]);

  const priorityColors: Record<string, string> = {
    low: 'bg-gray-100 text-gray-600',
    medium: 'bg-blue-100 text-blue-700',
    high: 'bg-orange-100 text-orange-700',
    urgent: 'bg-red-100 text-red-700',
  };

  const statusColors: Record<string, string> = {
    not_started: 'bg-gray-100 text-gray-600',
    in_progress: 'bg-blue-100 text-blue-700',
    waiting_materials: 'bg-orange-100 text-orange-700',
    needs_review: 'bg-purple-100 text-purple-700',
    completed: 'bg-green-100 text-green-700',
  };

  const filtered = items.filter(item => {
    if (search && !item.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const grouped = filtered.reduce((acc: Record<string, PunchItem[]>, item) => {
    const key = item.project_address || 'Unknown Project';
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-gray-900">Punch Lists</h1>
        <p className="text-sm text-gray-500 mt-0.5">{filtered.length} items across all projects</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search punch list items..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Statuses</option>
          <option value="not_started">Not Started</option>
          <option value="in_progress">In Progress</option>
          <option value="waiting_materials">Waiting Materials</option>
          <option value="needs_review">Needs Review</option>
          <option value="completed">Completed</option>
        </select>
        <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      {loading ? <Loading /> : (
        Object.keys(grouped).length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <ClipboardList className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No punch list items found</p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(grouped).map(([address, projectItems]) => {
              const projectId = items.find(i => i.project_address === address)?.project_id;
              return (
                <div key={address} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                    <div className="flex items-center gap-2">
                      <ClipboardList className="w-4 h-4 text-gray-500" />
                      <span className="font-semibold text-gray-900 text-sm">{address}</span>
                      <span className="text-xs text-gray-400">({projectItems.length})</span>
                    </div>
                    {projectId && (
                      <Link to={`/projects/${projectId}?tab=punch-list`} className="text-xs text-blue-600 hover:underline font-medium">View Project</Link>
                    )}
                  </div>
                  <div className="divide-y divide-gray-100">
                    {projectItems.map(item => (
                      <div key={item.id} className="px-4 py-3 flex items-start gap-3">
                        <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${item.status === 'completed' ? 'bg-green-500' : item.priority === 'urgent' ? 'bg-red-500' : item.priority === 'high' ? 'bg-orange-500' : 'bg-gray-300'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={`text-sm font-medium ${item.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-900'}`}>{item.title}</p>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${priorityColors[item.priority]}`}>{item.priority}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-1">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[item.status]}`}>{item.status.replace(/_/g, ' ')}</span>
                            {item.assigned_to_name && <span className="text-xs text-gray-500">{item.assigned_to_name}</span>}
                            {item.due_date && <span className="text-xs text-gray-400">Due {format(new Date(item.due_date), 'MMM d')}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
