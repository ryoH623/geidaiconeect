import { Link } from "react-router-dom";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function ModalMenu({ isOpen, onClose }: Props) {
  if (!isOpen) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3>メニュー</h3>
        <ul style={styles.list}>
          <li><Link to="/register">会員登録</Link></li>
          <li><Link to="/login">ログイン</Link></li>
          <li><Link to="/contact">お問い合わせ</Link></li>
        </ul>
        <button type="button" onClick={onClose} style={styles.closeButton}>閉じる</button>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1001,
  },
  modal: {
    backgroundColor: "#fff",
    padding: "20px",
    borderRadius: "8px",
    width: "80%",
    maxWidth: "300px",
  },
  list: {
    listStyle: "none",
    padding: 0,
  },
  closeButton: {
    marginTop: "15px",
    padding: "6px 12px",
    fontSize: "14px",
  },
};
