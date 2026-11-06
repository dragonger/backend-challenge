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
    <>
      <header className="nav">
        <div className="nav-inner">
          <a className="wordmark" href="#topo">
            Wagering
          </a>
          <nav className="nav-links" aria-label="Seções">
            <a href="#carteiras">Carteiras</a>
            <a href="#transacoes">Transações</a>
            <a href="#historico">Histórico</a>
          </nav>
          <StatusBar />
        </div>
      </header>

      <div className="app" id="topo">
        <section className="hero">
          <div className="hero-glow" aria-hidden="true" />
          <p className="eyebrow">Painel de demonstração · fora do escopo avaliado</p>
          <h1>
            Apostas consistentes.
            <br />
            Um ledger que fecha.
          </h1>
          <p className="hero-lead">
            Crie carteiras, envie BET, WIN, LOSS, REFUND e ROLLBACK, repita requisições para ver a idempotência
            e confira a reconciliação do saldo com o ledger.
          </p>
          <div className="hero-actions">
            <a className="btn primary" href="#carteiras">
              Criar carteira <span aria-hidden="true">↘</span>
            </a>
            <a className="btn ghost" href="#transacoes">
              Enviar transação
            </a>
          </div>
        </section>

        <main className="sections">
          <section className="section" id="carteiras">
            <div className="section-head">
              <p className="eyebrow">01</p>
              <h2 className="section-title">Carteiras</h2>
            </div>
            <div className="grid">
              <div className="column">
                <CreateWallet onCreated={handleCreated} />
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
                <WalletPanel
                  wallets={session.wallets}
                  selectedId={session.selectedId}
                  refreshKey={session.refreshKey}
                  onSelect={session.setSelectedId}
                  onOpened={session.addWallet}
                />
              </div>
            </div>
          </section>

          <section className="section" id="transacoes">
            <div className="section-head">
              <p className="eyebrow">02</p>
              <h2 className="section-title">Transações</h2>
            </div>
            <div className="grid">
              <div className="column">
                <TransactionForm
                  wallet={selected}
                  transactions={session.transactions}
                  onRecord={session.recordTransaction}
                  onDone={session.refresh}
                />
              </div>
              <div className="column">
                <ReconciliationPanel walletId={selected?.id ?? null} />
              </div>
            </div>
          </section>

          <section className="section" id="historico">
            <div className="section-head">
              <p className="eyebrow">03</p>
              <h2 className="section-title">Histórico</h2>
            </div>
            <div className="column">
              <TransactionHistory
                transactions={session.transactions}
                walletId={selected?.id ?? null}
                onStatus={session.updateStatus}
              />
              <LedgerPanel walletId={selected?.id ?? null} refreshKey={session.refreshKey} />
            </div>
          </section>
        </main>

        <footer className="footer muted small">
          Distributed Wagering Processor · Bun, NestJS, PostgreSQL e SQS
        </footer>
      </div>
    </>
  );
}
