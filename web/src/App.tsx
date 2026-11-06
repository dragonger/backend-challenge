import { CreateWallet } from './components/CreateWallet';
import { DisputeScenario } from './components/DisputeScenario';
import { LedgerPanel } from './components/LedgerPanel';
import { ReconciliationPanel } from './components/ReconciliationPanel';
import { StatusBar } from './components/StatusBar';
import { TransactionForm } from './components/TransactionForm';
import { TransactionHistory } from './components/TransactionHistory';
import { WalletPanel } from './components/WalletPanel';
import { useSession } from './lib/session';

export function App() {
  const session = useSession();
  const selected = session.wallets.find((wallet) => wallet.id === session.selectedId) ?? null;

  const handleCreated = (wallet: Parameters<typeof session.addWallet>[0]) => {
    session.addWallet(wallet);
    session.setSelectedId(wallet.id);
    session.refresh();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Painel Wagering</h1>
          <p className="muted">Painel de demonstração da API de wagering (extra, fora do escopo avaliado).</p>
        </div>
        <StatusBar />
      </header>

      <main className="grid">
        <div className="column">
          <CreateWallet onCreated={handleCreated} />
          <WalletPanel
            wallets={session.wallets}
            selectedId={session.selectedId}
            refreshKey={session.refreshKey}
            onSelect={session.setSelectedId}
            onOpened={session.addWallet}
          />
          <DisputeScenario
            onWalletCreated={session.addWallet}
            onRecord={session.recordTransaction}
            onSelect={(id) => {
              session.setSelectedId(id);
              session.refresh();
            }}
          />
        </div>
        <div className="column">
          <TransactionForm
            wallet={selected}
            transactions={session.transactions}
            onRecord={session.recordTransaction}
            onDone={session.refresh}
          />
          <ReconciliationPanel walletId={selected?.id ?? null} />
        </div>
        <div className="column wide">
          <TransactionHistory
            transactions={session.transactions}
            walletId={selected?.id ?? null}
            onStatus={session.updateStatus}
          />
          <LedgerPanel walletId={selected?.id ?? null} refreshKey={session.refreshKey} />
        </div>
      </main>
    </div>
  );
}
