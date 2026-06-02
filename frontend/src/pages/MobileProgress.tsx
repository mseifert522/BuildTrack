import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera } from 'lucide-react';

export default function MobileProgress() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    navigate(projectId ? `/mobile/photos?projectId=${projectId}&camera=1` : '/mobile/photos', { replace: true });
  }, [navigate, projectId]);

  return (
    <div className="mobile-shell" style={{ background: '#0D1117', alignItems: 'center', justifyContent: 'center' }}>
      <Camera size={34} color="#D99D26" />
      <p style={{ color: 'rgba(255,255,255,0.6)', marginTop: 12, fontSize: 13, fontWeight: 800 }}>
        Opening Take Progress Pictures...
      </p>
    </div>
  );
}
