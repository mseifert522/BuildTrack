import { type FormEvent, useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import api from '../lib/api';
import { PageHeader } from '../components/ui';
import { Bot, Copy, Key, Power, RefreshCw, Shield, User } from 'lucide-react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';

export default function Settings() {
  const { user, updateUser } = useAuthStore();
  const [activeTab, setActiveTab] = useState('profile');
  const [agents, setAgents] = useState<any[]>([]);
  const [agentLogs, setAgentLogs] = useState<any[]>([]);
  const [availableScopes, setAvailableScopes] = useState<string[]>([]);
  const [loadingBridge, setLoadingBridge] = useState(false);
  const [oneTimeKey, setOneTimeKey] = useState<{ agentName: string; apiKey: string } | null>(null);
  const [agentForm, setAgentForm] = useState({
    agentName: '',
    notes: '',
    allowedScopes: ['property:read', 'scope_of_work:write', 'punch_list:write'],
  });
  const { register: regProfile, handleSubmit: handleProfile, formState: { isSubmitting: savingProfile } } = useForm({
    defaultValues: { name: user?.name, phone: user?.phone, company: user?.company },
  });
  const { register: regPwd, handleSubmit: handlePwd, reset: resetPwd, formState: { isSubmitting: savingPwd } } = useForm();

  const onSaveProfile = async (data: any) => {
    try {
      const res = await api.put('/auth/profile', data);
      updateUser(res.data);
      toast.success('Profile updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update profile');
    }
  };

  const onChangePassword = async (data: any) => {
    if (data.new_password !== data.confirm_password) {
      toast.error('Passwords do not match');
      return;
    }
    try {
      await api.post('/auth/change-password', data);
      toast.success('Password changed successfully');
      resetPwd();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to change password');
    }
  };

  const loadAgentBridge = async () => {
    setLoadingBridge(true);
    try {
      const [agentsRes, logsRes] = await Promise.all([
        api.get('/agent-bridge/admin/agents'),
        api.get('/agent-bridge/admin/logs?limit=50'),
      ]);
      setAgents(Array.isArray(agentsRes.data?.agents) ? agentsRes.data.agents : []);
      setAvailableScopes(Array.isArray(agentsRes.data?.availableScopes) ? agentsRes.data.availableScopes : []);
      setAgentLogs(Array.isArray(logsRes.data?.logs) ? logsRes.data.logs : []);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load AI Agent Bridge');
    } finally {
      setLoadingBridge(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'agent-bridge') loadAgentBridge();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const toggleFormScope = (scope: string) => {
    setAgentForm(current => ({
      ...current,
      allowedScopes: current.allowedScopes.includes(scope)
        ? current.allowedScopes.filter(item => item !== scope)
        : [...current.allowedScopes, scope],
    }));
  };

  const createAgent = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const res = await api.post('/agent-bridge/admin/agents', agentForm);
      setOneTimeKey({ agentName: res.data?.agent?.agentName || agentForm.agentName, apiKey: res.data?.apiKey });
      setAgentForm({ agentName: '', notes: '', allowedScopes: ['property:read'] });
      toast.success('Agent created. Copy the API key now.');
      await loadAgentBridge();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to create agent');
    }
  };

  const updateAgent = async (agent: any, updates: Record<string, any>) => {
    try {
      await api.put(`/agent-bridge/admin/agents/${agent.id}`, { ...agent, ...updates });
      await loadAgentBridge();
      toast.success('Agent updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update agent');
    }
  };

  const toggleAgentScope = async (agent: any, scope: string) => {
    const currentScopes = Array.isArray(agent.allowedScopes) ? agent.allowedScopes : [];
    const allowedScopes = currentScopes.includes(scope)
      ? currentScopes.filter((item: string) => item !== scope)
      : [...currentScopes, scope];
    await updateAgent(agent, { allowedScopes });
  };

  const rotateAgentKey = async (agent: any) => {
    if (!window.confirm(`Generate a new API key for ${agent.agentName}? The old key will stop working.`)) return;
    try {
      const res = await api.post(`/agent-bridge/admin/agents/${agent.id}/rotate-key`);
      setOneTimeKey({ agentName: res.data?.agent?.agentName || agent.agentName, apiKey: res.data?.apiKey });
      await loadAgentBridge();
      toast.success('API key rotated. Copy the new key now.');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to rotate key');
    }
  };

  const copyText = async (text: string, message = 'Copied') => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message);
    } catch {
      toast.error('Copy failed');
    }
  };

  const tabs = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'security', label: 'Security', icon: Key },
    { id: 'agent-bridge', label: 'AI Agent Bridge', icon: Bot },
  ];

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto">
      <PageHeader title="Settings" subtitle="Manage your account settings" />

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${activeTab === id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'}`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'profile' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center">
              <span className="text-blue-700 font-bold text-2xl">{user?.name?.[0]?.toUpperCase()}</span>
            </div>
            <div>
              <p className="font-bold text-gray-900 text-lg">{user?.name}</p>
              <p className="text-gray-500 text-sm">{user?.email}</p>
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium capitalize">{user?.role?.replace(/_/g, ' ')}</span>
            </div>
          </div>

          <form onSubmit={handleProfile(onSaveProfile)} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
              <input {...regProfile('name')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input value={user?.email} disabled className="w-full px-3.5 py-2.5 rounded-lg border border-gray-200 text-sm bg-gray-50 text-gray-500" />
              <p className="text-xs text-gray-400 mt-1">Email cannot be changed here. Contact your admin.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input {...regProfile('phone')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="+1 (555) 000-0000" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
              <input {...regProfile('company')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Your company name" />
            </div>
            <button type="submit" disabled={savingProfile} className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50">
              {savingProfile ? 'Saving...' : 'Save Profile'}
            </button>
          </form>
        </div>
      )}

      {activeTab === 'security' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center">
              <Shield className="w-5 h-5 text-orange-600" />
            </div>
            <div>
              <p className="font-semibold text-gray-900">Change Password</p>
              <p className="text-xs text-gray-500">Use a strong password with at least 8 characters</p>
            </div>
          </div>

          <form onSubmit={handlePwd(onChangePassword)} className="space-y-4">
            {!user?.force_password_reset && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Current Password</label>
                <input type="password" {...regPwd('current_password')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            )}
            {user?.force_password_reset && (
              <div className="bg-orange-50 rounded-lg p-3 text-sm text-orange-700">
                You must change your temporary password before continuing.
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
              <input type="password" {...regPwd('new_password', { required: true, minLength: 8 })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Min. 8 characters" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Confirm New Password</label>
              <input type="password" {...regPwd('confirm_password', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <button type="submit" disabled={savingPwd} className="w-full py-2.5 bg-orange-600 text-white rounded-xl text-sm font-semibold hover:bg-orange-700 transition-colors disabled:opacity-50">
              {savingPwd ? 'Changing...' : 'Change Password'}
            </button>
          </form>
        </div>
      )}

      {activeTab === 'agent-bridge' && (
        <div className="space-y-5">
          {oneTimeKey?.apiKey && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-black text-amber-900">One-time API key for {oneTimeKey.agentName}</p>
              <p className="mt-1 text-xs font-semibold text-amber-800">This key is shown once. Store it in Hermes secrets, not in frontend code.</p>
              <div className="mt-3 flex gap-2">
                <code className="min-w-0 flex-1 rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-amber-950">{oneTimeKey.apiKey}</code>
                <button type="button" onClick={() => copyText(oneTimeKey.apiKey, 'API key copied')} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-black text-white">
                  <Copy className="h-3.5 w-3.5" /> Copy
                </button>
              </div>
            </div>
          )}

          <form onSubmit={createAgent} className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-black text-gray-950">Create Agent</h2>
                <p className="text-xs font-semibold text-gray-500">Generate a per-agent API key and permission scope.</p>
              </div>
              <button type="button" onClick={loadAgentBridge} disabled={loadingBridge} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700">
                <RefreshCw className={`h-3.5 w-3.5 ${loadingBridge ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-black uppercase tracking-wide text-gray-500">Agent name</label>
                <input value={agentForm.agentName} onChange={event => setAgentForm(current => ({ ...current, agentName: event.target.value }))} required placeholder="Benito" className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-black uppercase tracking-wide text-gray-500">Notes</label>
                <input value={agentForm.notes} onChange={event => setAgentForm(current => ({ ...current, notes: event.target.value }))} placeholder="Telegram construction commands" className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div className="mt-4">
              <p className="mb-2 text-xs font-black uppercase tracking-wide text-gray-500">Allowed scopes</p>
              <div className="flex flex-wrap gap-2">
                {availableScopes.map(scope => (
                  <button key={scope} type="button" onClick={() => toggleFormScope(scope)} className={`rounded-full border px-3 py-1.5 text-xs font-black ${agentForm.allowedScopes.includes(scope) ? 'border-blue-500 bg-blue-600 text-white' : 'border-gray-300 bg-white text-gray-700'}`}>
                    {scope}
                  </button>
                ))}
              </div>
            </div>
            <button type="submit" className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white hover:bg-blue-700">
              <Key className="h-4 w-4" /> Generate API Key
            </button>
          </form>

          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-black text-gray-950">Registered Agents</h2>
            <div className="mt-3 divide-y divide-gray-100">
              {agents.length === 0 && <p className="py-6 text-center text-sm font-semibold text-gray-400">No agents registered yet.</p>}
              {agents.map(agent => (
                <div key={agent.id} className="py-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="font-black text-gray-950">{agent.agentName}</p>
                      <p className="text-xs font-semibold text-gray-500">Last used: {agent.lastUsedAt || 'Never'}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {availableScopes.map(scope => (
                          <button
                            key={scope}
                            type="button"
                            onClick={() => toggleAgentScope(agent, scope)}
                            className={`rounded-full border px-2 py-0.5 text-[11px] font-black ${agent.allowedScopes?.includes(scope) ? 'border-blue-200 bg-blue-100 text-blue-700' : 'border-gray-200 bg-gray-50 text-gray-400'}`}
                          >
                            {scope}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => updateAgent(agent, { enabled: !agent.enabled })} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-black ${agent.enabled ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                        <Power className="h-3.5 w-3.5" /> {agent.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button type="button" onClick={() => rotateAgentKey(agent)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-xs font-black text-gray-700">
                        <RefreshCw className="h-3.5 w-3.5" /> Rotate Key
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-black text-gray-950">Hermes Tool Instructions</h2>
              <p className="mt-2 text-sm leading-6 text-gray-600">When the user says 'scope of work' followed by an address and task details, call BuildTrack Agent Bridge using the scope_of_work endpoint. First identify the property address. Convert the spoken tasks into clean line-by-line construction scope items. Do not invent property addresses. If the property is missing or ambiguous, ask the user to clarify. If the user says 'punch list' followed by an address and task details, call the punch_list endpoint and create clean line-by-line punch-list tasks.</p>
              <button type="button" onClick={() => copyText("When the user says 'scope of work' followed by an address and task details, call BuildTrack Agent Bridge using the scope_of_work endpoint. First identify the property address. Convert the spoken tasks into clean line-by-line construction scope items. Do not invent property addresses. If the property is missing or ambiguous, ask the user to clarify. If the user says 'punch list' followed by an address and task details, call the punch_list endpoint and create clean line-by-line punch-list tasks.", 'Hermes instructions copied')} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-xs font-black text-gray-700">
                <Copy className="h-3.5 w-3.5" /> Copy Instructions
              </button>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-black text-gray-950">Sample API Call</h2>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{`curl -X POST https://buildtrack.newurbandev.com/api/agent-bridge/scope-of-work \\
  -H "Authorization: Bearer $AGENT_API_KEY" \\
  -H "X-BuildTrack-Agent-Name: Benito" \\
  -H "X-Request-Id: telegram-message-id" \\
  -H "Content-Type: application/json" \\
  -d '{"propertyAddress":"123 Main Street, Detroit, MI","rawTranscript":"Scope of work for 123 Main Street: demo kitchen cabinets, paint bedrooms"}'`}</pre>
              <button type="button" onClick={() => copyText('https://buildtrack.newurbandev.com/api/agent-bridge/admin/openapi.json', 'OpenAPI URL copied')} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-xs font-black text-gray-700">
                <Copy className="h-3.5 w-3.5" /> Copy OpenAPI URL
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-black text-gray-950">Recent Requests</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100 text-sm">
                <thead>
                  <tr className="text-left text-xs font-black uppercase tracking-wide text-gray-500">
                    <th className="py-2 pr-4">Time</th>
                    <th className="py-2 pr-4">Agent</th>
                    <th className="py-2 pr-4">Intent</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Property</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {agentLogs.map(log => (
                    <tr key={log.id}>
                      <td className="py-2 pr-4 text-xs text-gray-500">{log.createdAt}</td>
                      <td className="py-2 pr-4 font-semibold text-gray-900">{log.agentName || '-'}</td>
                      <td className="py-2 pr-4 text-gray-700">{log.intent || '-'}</td>
                      <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-xs font-black ${log.success ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{log.success ? 'success' : log.errorCode || 'failed'}</span></td>
                      <td className="py-2 pr-4 text-gray-600">{log.propertyAddress || log.propertyId || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {agentLogs.length === 0 && <p className="py-6 text-center text-sm font-semibold text-gray-400">No agent requests logged yet.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
