import {
  Camera,
  ClipboardList,
  FileText,
  FolderOpen,
  MapPin,
  MessageSquare,
} from 'lucide-react';

type PreviewProject = {
  id: string;
  address: string;
  label: string;
  status: string;
  punch: number;
  scopeEnabled: boolean;
  punchEnabled: boolean;
};

const previewProjects: PreviewProject[] = [
  {
    id: 'garner',
    address: '895 N Garner Rd, Troy, MI',
    label: '895 N Garner',
    status: 'Active Rehab',
    punch: 2,
    scopeEnabled: true,
    punchEnabled: true,
  },
  {
    id: 'chopin',
    address: '160 Chopin Ave, Troy, MI',
    label: '160 Chopin',
    status: 'Active Rehab',
    punch: 0,
    scopeEnabled: true,
    punchEnabled: false,
  },
  {
    id: 'robina',
    address: '3170 Robina Ave, Berkley, MI',
    label: '3170 Robina',
    status: 'Assigned',
    punch: 0,
    scopeEnabled: false,
    punchEnabled: false,
  },
];

export default function MobileContractorPreview() {
  return (
    <div className="mobile-shell btm-home-shell">
      <header className="btm-home-header">
        <div className="btm-home-topbar">
          <div className="btm-brand">
            <div className="btm-brand-mark" aria-hidden="true">
              <img src="/buildtrack-logo-mark.png" alt="" className="btm-brand-logo" />
            </div>
            <div className="btm-brand-text">
              <p>BuildTrack</p>
              <span>Contractor / Field Preview</span>
            </div>
          </div>
        </div>

        <div className="btm-context-strip btm-context-strip-assigned">
          <div>
            <span>Your Assigned Projects</span>
            <strong>{previewProjects.length}</strong>
          </div>
        </div>
      </header>

      <main className="mobile-content btm-home-content">
        <section className="btm-list-section" aria-label="Assigned project preview">
          <div className="btm-section-header">
            <p>{previewProjects.length} Assigned Projects</p>
          </div>

          {previewProjects.map(project => (
            <article key={project.id} className="btm-project-card">
              <button type="button" className="btm-project-main">
                <span className="btm-project-pin" aria-hidden="true">
                  <MapPin size={24} />
                </span>
                <span className="btm-project-copy">
                  <strong>{project.address}</strong>
                  <small>{project.label}</small>
                  <span className="btm-project-badges">
                    <span className="btm-status-pill btm-status-success">{project.status}</span>
                    {project.punch > 0 && <span className="btm-status-pill btm-status-danger">{project.punch} punch</span>}
                  </span>
                </span>
              </button>

              <div className="btm-project-actions">
                <button type="button" className="btm-action-button btm-action-photo">
                  <Camera size={22} />
                  <span>Take Progress photos</span>
                </button>
                <button type="button" className="btm-action-button btm-action-open">
                  <FolderOpen size={22} />
                  <span>View Project</span>
                </button>
                {project.scopeEnabled && (
                  <button type="button" className="btm-action-button btm-action-scope">
                    <FileText size={22} />
                    <span>Scope of Work</span>
                  </button>
                )}
                {project.punchEnabled && (
                  <button type="button" className={`btm-action-button ${project.punch > 0 ? 'btm-action-punch-hot' : 'btm-action-punch'}`}>
                    <ClipboardList size={22} />
                    <span>Punch List</span>
                  </button>
                )}
                <button type="button" className="btm-action-button btm-action-notes">
                  <MessageSquare size={22} />
                  <span>Notes</span>
                </button>
                <button type="button" className="btm-action-button btm-action-invoice">
                  <FileText size={22} />
                  <span>Create Invoice</span>
                </button>
              </div>
            </article>
          ))}
        </section>
      </main>

      <nav className="btm-bottom-nav" aria-label="Mobile sections">
        <button type="button" className="btm-nav-item btm-tone-blue is-active" aria-current="page">
          <FolderOpen size={22} />
          <span>Projects</span>
        </button>
        <button type="button" className="btm-nav-item btm-tone-amber">
          <Camera size={22} />
          <span>Photos</span>
        </button>
        <button type="button" className="btm-nav-item btm-tone-violet">
          <FileText size={22} />
          <span>Invoices</span>
        </button>
      </nav>
    </div>
  );
}
