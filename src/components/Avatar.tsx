import { useState } from 'react';

export function Avatar({
  user,
  size,
  online,
}: {
  user?: { first_name?: string; last_name?: string; photo?: string | null } | null;
  size?: number;
  online?: boolean;
}) {
  const photo = user?.photo;
  const initials =
    [user?.first_name, user?.last_name].filter(Boolean).map((s) => (s as string)[0]?.toUpperCase()).join('') || '?';
  const [imgFailed, setImgFailed] = useState(false);
  const showPhoto = photo && !imgFailed;
  return (
    <div
      className={`avatar${showPhoto ? ' has-photo' : ''}`}
      style={size ? { width: size, height: size, fontSize: size * 0.42 } : undefined}
    >
      {showPhoto ? <img className="avatar-img" src={photo} alt="" onError={() => setImgFailed(true)} /> : initials}
      {online && <span className="online-dot" />}
    </div>
  );
}
