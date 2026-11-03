import AdminNotifications from "./AdminNotifications";

export default function GuardNotifications(props) {
  return <AdminNotifications {...props} audience="guard" />;
}
