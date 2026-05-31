import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Camera,
  ChevronRight,
  FileText,
  FolderOpen,
  LogOut,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  Send,
  Truck,
  Users,
} from 'lucide-react';
import { useAuthStore, roleLabels, canCreateProjects } from '../store/authStore';
import api from '../lib/api';

interface Project {
  id: string;
  address: string;
  job_name?: string;
  status: string;
  open_punch_items?: number;
}

interface ContractorItem {
  id: string;
  name?: string;
  company?: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  category?: string;
  contractor_category?: string;
  connected_project_count?: number;
  assigned_project_count?: number;
}

interface SupplierItem {
  id: string;
  name?: string;
  contact?: string;
  phone?: string;
  email?: string;
  category?: string;
}

type Tab = 'projects' | 'photos' | 'invoices' | 'contractors' | 'suppliers';

function isManagementRole(role?: string) {
  return role === 'super_admin' || role === 'operations_manager' || role === 'project_manager';
}

function statusLabel(status?: string) {
  return (status || 'active').replace(/_/g, ' ');
}

function clearMobilePhotoProjectState() {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('buildtrack-mobile-photo-project:')) localStorage.removeItem(key);
  });
}

export default function MobileHome() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const managementUser = isManagementRole(user?.role);
  const storageKey = `buildtrack-mobile-photo-project:${user?.id || 'session'}`;

  const [tab, setTab] = useState<Tab>('projects');
  const [projects, setProjects] = useState<Project[]>([]);
  const [contractors, setContractors] = useState<ContractorItem[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [setupEmailInputs, setSetupEmailInputs] = useState<Record<string, string>>({});
  const [sendingSetupId, setSendingSetupId] = useState<string | null>(null);

  const navItems = useMemo(() => {
    if (managementUser) {
      return [
        { key: 'projects' as Tab, label: 'Projects', Icon: FolderOpen, color: '#2563EB' },
        { key: 'photos' as Tab, label: 'Progress Photos', Icon: Camera, color: '#D99D26' },
        { key: 'contractors' as Tab, label: 'Contractors', Icon: Users, color: '#16A34A' },
        { key: 'suppliers' as Tab, label: 'Suppliers', Icon: Truck, color: '#7C3AED' },
      ];
    }
    return [
      { key: 'projects' as Tab, label: 'Projects', Icon: FolderOpen, color: '#2563EB' },
      { key: 'photos' as Tab, label: 'Progress Photos', Icon: Camera, color: '#D99D26' },
      { key: 'invoices' as Tab, label: 'Invoice', Icon: FileText, color: '#7C3AED' },
    ];
  }, [managementUser]);

  const loadData = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      const projectRes = await api.get('/projects');
      setProjects(Array.isArray(projectRes.data) ? projectRes.data : []);

      if (managementUser) {
        const [contractorRes, supplierRes] = await Promise.all([
          api.get('/users/contractors/directory').catch(() => ({ data: { contractors: [] } })),
          api.get('/users/suppliers').catch(() => ({ data: [] })),
        ]);
        setContractors(Array.isArray(contractorRes.data?.contractors) ? contractorRes.data.contractors : []);
        setSuppliers(Array.isArray(supplierRes.data) ? supplierRes.data : []);
      }
    } catch {
      toast.error('Failed to load mobile data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [managementUser]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => loadData(true), 30000);
    return () => window.clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    if (!navItems.some(item => item.key === tab)) setTab('projects');
  }, [navItems, tab]);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredProjects = projects.filter(project =>
    project.address.toLowerCase().includes(normalizedSearch) ||
    (project.job_name || '').toLowerCase().includes(normalizedSearch)
  );
  const filteredContractors = contractors.filter(contractor =>
    (contractor.name || contractor.company || contractor.contact_name || '').toLowerCase().includes(normalizedSearch) ||
    (contractor.email || '').toLowerCase().includes(normalizedSearch) ||
    (contractor.phone || '').toLowerCase().includes(normalizedSearch)
  );
  const filteredSuppliers = suppliers.filter(supplier =>
    (supplier.name || supplier.contact || '').toLowerCase().includes(normalizedSearch) ||
    (supplier.email || '').toLowerCase().includes(normalizedSearch) ||
    (supplier.phone || '').toLowerCase().includes(normalizedSearch)
  );

  const rememberedProject = projects.find(project => project.id === localStorage.getItem(storageKey));

  const sendContractorSetup = async (contractor: ContractorItem) => {
    const email = String(setupEmailInputs[contractor.id] ?? contractor.email ?? '').trim();
    if (!email) {
      toast.error('Enter an email for the secure 1099 setup link');
      return;
    }

    setSendingSetupId(contractor.id);
    try {
      await api.post(`/contractor-onboarding/contractors/${contractor.id}/request`, {
        email,
        save_email: !contractor.email,
      });
      toast.success('Secure 1099 setup link sent');
      await loadData(true);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send setup link');
    } finally {
      setSendingSetupId(null);
    }
  };

  const handleLogout = () => {
    logout();
    localStorage.removeItem('contractor_token');
    localStorage.removeItem('contractor_user');
    localStorage.removeItem('contractor_projects');
    localStorage.removeItem('contractor_session_started_at');
    localStorage.removeItem('contractor_last_activity_at');
    localStorage.removeItem('contractor_last_refresh_at');
    clearMobilePhotoProjectState();
    navigate('/login');
  };

  if (loading) {
    return (
      <div className="mobile-shell" style={{ background: '#0D1117', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 54, height: 54, borderRadius: 16, background: 'linear-gradient(135deg, #D99D26, #C4891F)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
          <MapPin size={27} color="white" />
        </div>
        <RefreshCw size={34} color="#D99D26" style={{ animation: 'spin 0.8s linear infinite' }} />
        <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, marginTop: 13 }}>Loading BuildTrack...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="mobile-shell" style={{ background: '#F4F5F7' }}>
      <div className="mobile-header" style={{ background: 'linear-gradient(135deg, #0D1117 0%, #181D25 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '14px 14px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, #D99D26, #C4891F)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <MapPin size={19} color="white" />
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ color: 'white', fontSize: 15, fontWeight: 850, margin: 0 }}>BuildTrack</p>
              <p style={{ color: '#D99D26', fontSize: 11, fontWeight: 700, margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.name?.split(' ')[0] || 'User'} / {roleLabels[user?.role || ''] || 'Mobile'}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {refreshing && <RefreshCw size={15} color="rgba(255,255,255,0.45)" style={{ animation: 'spin 0.8s linear infinite' }} />}
            {canCreateProjects(user?.role || '') && (
              <button
                onClick={() => navigate('/mobile/add-project')}
                style={{ width: 36, height: 36, borderRadius: 10, border: 'none', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Plus size={17} color="rgba(255,255,255,0.76)" />
              </button>
            )}
            <button
              onClick={handleLogout}
              style={{ width: 36, height: 36, borderRadius: 10, border: 'none', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <LogOut size={16} color="rgba(255,255,255,0.76)" />
            </button>
          </div>
        </div>

        <div style={{ padding: '0 14px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'rgba(255,255,255,0.08)', borderRadius: 14, padding: '10px 12px' }}>
            <Search size={15} color="rgba(255,255,255,0.45)" />
            <input
              type="text"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={managementUser ? 'Search projects, contractors, suppliers' : 'Search assigned projects'}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'white', fontSize: 14 }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          {navItems.map(item => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '10px 3px', border: 'none', borderBottom: active ? `2px solid ${item.color}` : '2px solid transparent', background: 'transparent', color: active ? item.color : 'rgba(255,255,255,0.46)' }}
              >
                <item.Icon size={18} />
                <span style={{ maxWidth: '100%', fontSize: 10, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mobile-content" style={{ padding: '12px 14px 86px' }}>
        {tab === 'projects' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: '#6B7280', fontSize: 11, fontWeight: 850, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '2px 2px 0' }}>
              {filteredProjects.length} Project{filteredProjects.length === 1 ? '' : 's'}
            </p>

            {filteredProjects.length === 0 ? (
              <div style={{ textAlign: 'center', background: 'white', borderRadius: 18, padding: '48px 20px' }}>
                <FolderOpen size={42} color="#D1D5DB" />
                <p style={{ color: '#6B7280', fontSize: 14, fontWeight: 800, margin: '10px 0 0' }}>No projects found</p>
              </div>
            ) : filteredProjects.map(project => (
              <div key={project.id} style={{ background: 'white', borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 8px rgba(0,0,0,0.07)' }}>
                <button
                  onClick={() => navigate(`/mobile/project/${project.id}`)}
                  style={{ width: '100%', border: 'none', background: 'white', textAlign: 'left', padding: 13, display: 'flex', gap: 10, alignItems: 'center' }}
                >
                  <div style={{ width: 39, height: 39, borderRadius: 10, background: 'rgba(217,157,38,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <MapPin size={18} color="#D99D26" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#111827', fontSize: 13, fontWeight: 850, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.address}</p>
                    <p style={{ color: '#6B7280', fontSize: 11, margin: '2px 0 0', textTransform: 'capitalize' }}>{project.job_name || statusLabel(project.status)}</p>
                  </div>
                  <ChevronRight size={16} color="#9CA3AF" />
                </button>

                <div style={{ display: 'grid', gridTemplateColumns: managementUser ? '1fr 1fr' : '1fr 1fr 1fr', borderTop: '1px solid #F3F4F6' }}>
                  <button onClick={() => navigate(`/mobile/project/${project.id}`)} style={{ border: 'none', background: '#FAFAFA', padding: '10px 4px', fontSize: 11, fontWeight: 850, color: '#2563EB', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                    <FolderOpen size={15} color="#2563EB" /> Open
                  </button>
                  <button onClick={() => navigate(`/mobile/photos?projectId=${project.id}`)} style={{ border: 'none', borderLeft: '1px solid #F3F4F6', background: '#FAFAFA', padding: '10px 4px', fontSize: 11, fontWeight: 850, color: '#D99D26', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                    <Camera size={15} color="#D99D26" /> Progress
                  </button>
                  {!managementUser && (
                    <button onClick={() => navigate(`/mobile/project/${project.id}/invoice`)} style={{ border: 'none', borderLeft: '1px solid #F3F4F6', background: '#FAFAFA', padding: '10px 4px', fontSize: 11, fontWeight: 850, color: '#7C3AED', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                      <FileText size={15} color="#7C3AED" /> Invoice
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'photos' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              onClick={() => navigate(rememberedProject ? `/mobile/photos?projectId=${rememberedProject.id}` : '/mobile/photos')}
              style={{ width: '100%', border: 'none', borderRadius: 18, padding: 16, textAlign: 'left', background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', boxShadow: '0 8px 18px rgba(217,157,38,0.22)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 13, background: 'rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Camera size={22} color="white" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 900 }}>Add Progress Photos</p>
                  <p style={{ margin: '3px 0 0', fontSize: 12, opacity: 0.82, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {rememberedProject ? `Continue with ${rememberedProject.address}` : 'Choose a project before uploading photos or videos'}
                  </p>
                </div>
                <ChevronRight size={18} color="white" />
              </div>
            </button>

            <p style={{ color: '#6B7280', fontSize: 11, fontWeight: 850, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '4px 2px 0' }}>
              Select Project
            </p>
            {filteredProjects.map(project => (
              <button
                key={project.id}
                onClick={() => navigate(`/mobile/photos?projectId=${project.id}`)}
                style={{ width: '100%', border: 'none', background: 'white', borderRadius: 15, padding: 13, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}
              >
                <Camera size={18} color="#D99D26" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ color: '#111827', margin: 0, fontSize: 13, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.address}</p>
                  <p style={{ color: '#6B7280', margin: '2px 0 0', fontSize: 11 }}>Upload timestamped photos or videos</p>
                </div>
                <ChevronRight size={16} color="#9CA3AF" />
              </button>
            ))}
          </div>
        )}

        {tab === 'invoices' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: '#6B7280', fontSize: 11, fontWeight: 850, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '2px 2px 0' }}>
              Select Project to Invoice
            </p>
            {filteredProjects.map(project => (
              <button
                key={project.id}
                onClick={() => navigate(`/mobile/project/${project.id}/invoice`)}
                style={{ width: '100%', border: 'none', background: 'white', borderRadius: 15, padding: 13, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}
              >
                <FileText size={18} color="#7C3AED" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ color: '#111827', margin: 0, fontSize: 13, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.address}</p>
                  <p style={{ color: '#6B7280', margin: '2px 0 0', fontSize: 11 }}>Create invoice</p>
                </div>
                <ChevronRight size={16} color="#9CA3AF" />
              </button>
            ))}
          </div>
        )}

        {tab === 'contractors' && managementUser && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: '#6B7280', fontSize: 11, fontWeight: 850, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '2px 2px 0' }}>
              {filteredContractors.length} Contractor{filteredContractors.length === 1 ? '' : 's'}
            </p>
            {filteredContractors.slice(0, 80).map(contractor => {
              const setupEmail = setupEmailInputs[contractor.id] ?? contractor.email ?? '';
              return (
                <div key={contractor.id} style={{ background: 'white', borderRadius: 15, padding: 13, boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(22,163,74,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Users size={18} color="#16A34A" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ color: '#111827', margin: 0, fontSize: 13, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contractor.name || contractor.company || contractor.contact_name || 'Contractor'}</p>
                      <p style={{ color: '#6B7280', margin: '2px 0 0', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contractor.contractor_category || contractor.category || contractor.email || contractor.phone || 'Contractor'}</p>
                    </div>
                    <span style={{ color: '#16A34A', fontSize: 11, fontWeight: 850 }}>{contractor.connected_project_count ?? contractor.assigned_project_count ?? 0}</span>
                  </div>
                  <div style={{ marginTop: 10, borderTop: '1px solid #F3F4F6', paddingTop: 10 }}>
                    <p style={{ color: '#92400E', margin: '0 0 6px', fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Secure 1099 setup</p>
                    <div style={{ display: 'flex', gap: 7 }}>
                      <input
                        type="email"
                        value={setupEmail}
                        onChange={event => setSetupEmailInputs(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                        placeholder="contractor@email.com"
                        style={{ minWidth: 0, flex: 1, border: '1px solid #E5E7EB', borderRadius: 11, padding: '10px 11px', fontSize: 12, fontWeight: 750, outline: 'none' }}
                      />
                      <button
                        type="button"
                        onClick={() => sendContractorSetup(contractor)}
                        disabled={sendingSetupId === contractor.id}
                        style={{ border: 'none', borderRadius: 11, background: '#111827', color: 'white', width: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: sendingSetupId === contractor.id ? 0.6 : 1 }}
                        aria-label="Send secure 1099 setup link"
                      >
                        <Send size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'suppliers' && managementUser && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: '#6B7280', fontSize: 11, fontWeight: 850, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '2px 2px 0' }}>
              {filteredSuppliers.length} Supplier{filteredSuppliers.length === 1 ? '' : 's'}
            </p>
            {filteredSuppliers.slice(0, 80).map(supplier => (
              <div key={supplier.id} style={{ background: 'white', borderRadius: 15, padding: 13, display: 'flex', gap: 10, alignItems: 'center', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(124,58,237,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Truck size={18} color="#7C3AED" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ color: '#111827', margin: 0, fontSize: 13, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{supplier.name || supplier.contact || 'Supplier'}</p>
                  <p style={{ color: '#6B7280', margin: '2px 0 0', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{supplier.category || supplier.email || supplier.phone || 'Supplier'}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mobile-bottom-nav" style={{ background: 'white', borderTop: '1px solid #E5E7EB', boxShadow: '0 -4px 18px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${navItems.length}, 1fr)` }}>
          {navItems.map(item => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                style={{ minWidth: 0, position: 'relative', border: 'none', background: 'transparent', padding: '10px 2px 8px', color: active ? item.color : '#9CA3AF', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}
              >
                {active && <span style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 28, height: 3, borderRadius: '0 0 3px 3px', background: item.color }} />}
                <item.Icon size={20} />
                <span style={{ maxWidth: '100%', fontSize: 10, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
