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
  return (
    <div
      className={`avatar${photo ? ' has-photo' : ''}`}
      style={size ? { width: size, height: size, fontSize: size * 0.42 } : undefined}
    >
      {photo ? <img className="avatar-img" src={photo} alt="" /> : initials}
      {online && <span className="online-dot" />}
    </div>
  );
}
