// src/components/Header.tsx
import Logo from "./Logo";

export default function Header() {
  return (
    <header style={{ 
      display: "flex", 
      justifyContent: "space-between", 
      alignItems: "center", 
      padding: "10px 20px", 
      borderBottom: "1px solid #ccc" 
    }}>
      {/* 左：三本線メニュー */}
      <div>
        <button type="button" style={{ fontSize: "24px" }}>☰</button>
      </div>

      {/* 中央：ロゴ */}
      <div style={{ flexGrow: 1, textAlign: "center" }}>
        <Logo />
      </div>

      {/* 右：虫眼鏡 */}
      <div>
        <button type="button" style={{ fontSize: "24px" }}>🔍</button>
      </div>
    </header>
  );
}
