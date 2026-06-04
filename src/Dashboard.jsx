import React, { useState, useEffect } from 'react';
import './Dashboard.css';

export default function Dashboard() {
  const [invoices, setInvoices] = useState([]);
  const [filteredInvoices, setFilteredInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterSupplier, setFilterSupplier] = useState('');
  const [filterPayment, setFilterPayment] = useState('');
  const [filterAccount, setFilterAccount] = useState('');
  const [sortBy, setSortBy] = useState('date-desc');

  // Fetch invoices
  useEffect(() => {
    fetchInvoices();
    const interval = setInterval(fetchInvoices, 10000); // Update every 10s
    return () => clearInterval(interval);
  }, []);

  const fetchInvoices = async () => {
    try {
      const response = await fetch('/api/invoices');
      const data = await response.json();
      
      const invoiceList = Object.entries(data).map(([id, invoice]) => ({
        id,
        ...invoice
      }));
      
      setInvoices(invoiceList);
      setLoading(false);
    } catch (error) {
      console.error('Fetch error:', error);
      setLoading(false);
    }
  };

  // Apply filters
  useEffect(() => {
    let filtered = invoices;

    if (filterSupplier) {
      filtered = filtered.filter(inv => 
        inv.supplier.toLowerCase().includes(filterSupplier.toLowerCase())
      );
    }

    if (filterPayment) {
      filtered = filtered.filter(inv => inv.paymentMethod === filterPayment);
    }

    if (filterAccount) {
      filtered = filtered.filter(inv => inv.account === filterAccount);
    }

    // Sort
    filtered.sort((a, b) => {
      const dateA = new Date(a.timestamp);
      const dateB = new Date(b.timestamp);
      return sortBy === 'date-desc' ? dateB - dateA : dateA - dateB;
    });

    setFilteredInvoices(filtered);
  }, [invoices, filterSupplier, filterPayment, filterAccount, sortBy]);

  const stats = {
    total: invoices.length,
    cash: invoices.filter(i => i.paymentMethod === 'Bar').length,
    card: invoices.filter(i => i.paymentMethod === 'Karte').length,
    vat20: invoices.filter(i => i.vatRate === '20%').length,
    vat10: invoices.filter(i => i.vatRate === '10%').length,
  };

  if (loading) {
    return <div className="container"><div className="loading">⏳ Lädt...</div></div>;
  }

  return (
    <div className="container">
      <header className="header">
        <div className="header-content">
          <h1>🧾 Zeytoon Rechnungs-Dashboard</h1>
          <p className="subtitle">Verwalte alle eingescannten Rechnungen</p>
        </div>
        <button className="btn-refresh" onClick={fetchInvoices}>🔄 Aktualisieren</button>
      </header>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-number">{stats.total}</div>
          <div className="stat-label">Rechnungen</div>
        </div>
        <div className="stat-card">
          <div className="stat-number">{stats.cash}</div>
          <div className="stat-label">Bar 💵</div>
        </div>
        <div className="stat-card">
          <div className="stat-number">{stats.card}</div>
          <div className="stat-label">Karte 💳</div>
        </div>
        <div className="stat-card">
          <div className="stat-number">{stats.vat20}</div>
          <div className="stat-label">MwSt 20%</div>
        </div>
        <div className="stat-card">
          <div className="stat-number">{stats.vat10}</div>
          <div className="stat-label">MwSt 10%</div>
        </div>
      </div>

      {/* Filters */}
      <div className="filters-section">
        <div className="filters-grid">
          <input
            type="text"
            placeholder="🔍 Nach Lieferant suchen..."
            value={filterSupplier}
            onChange={(e) => setFilterSupplier(e.target.value)}
            className="filter-input"
          />
          
          <select 
            value={filterPayment} 
            onChange={(e) => setFilterPayment(e.target.value)}
            className="filter-select"
          >
            <option value="">Alle Zahlungsarten</option>
            <option value="Bar">Bar</option>
            <option value="Karte">Karte</option>
          </select>

          <select 
            value={filterAccount} 
            onChange={(e) => setFilterAccount(e.target.value)}
            className="filter-select"
          >
            <option value="">Alle Konten</option>
            <option value="Geschäftskonto">Geschäftskonto</option>
            <option value="Privat">Privat</option>
          </select>

          <select 
            value={sortBy} 
            onChange={(e) => setSortBy(e.target.value)}
            className="filter-select"
          >
            <option value="date-desc">Neuste zuerst</option>
            <option value="date-asc">Älteste zuerst</option>
          </select>
        </div>

        {(filterSupplier || filterPayment || filterAccount) && (
          <button 
            className="btn-clear-filters"
            onClick={() => {
              setFilterSupplier('');
              setFilterPayment('');
              setFilterAccount('');
            }}
          >
            ✕ Filter löschen
          </button>
        )}
      </div>

      {/* Invoices Table */}
      <div className="invoices-section">
        {filteredInvoices.length === 0 ? (
          <div className="empty-state">
            <p>📭 Keine Rechnungen gefunden</p>
            <small>Lade eine Rechnung in Telegram hoch, um sie hier zu sehen</small>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="invoices-table">
              <thead>
                <tr>
                  <th>📅 Datum</th>
                  <th>📦 Lieferant</th>
                  <th>💰 Zahlungsart</th>
                  <th>🏦 Konto</th>
                  <th>📊 MwSt</th>
                  <th>📄 Dateiname</th>
                </tr>
              </thead>
              <tbody>
                {filteredInvoices.map((invoice) => (
                  <tr key={invoice.id} className="invoice-row">
                    <td className="date">
                      {new Date(invoice.timestamp).toLocaleDateString('de-AT')}
                    </td>
                    <td className="supplier">{invoice.supplier}</td>
                    <td className="payment">
                      <span className={`badge badge-${invoice.paymentMethod === 'Bar' ? 'cash' : 'card'}`}>
                        {invoice.paymentMethod === 'Bar' ? '💵' : '💳'} {invoice.paymentMethod}
                      </span>
                    </td>
                    <td className="account">{invoice.account}</td>
                    <td className="vat">
                      <span className="vat-badge">{invoice.vatRate}</span>
                    </td>
                    <td className="filename">
                      <code>{invoice.fileName}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="footer">
        <p>🤖 Zeytoon Receipt Bot • Firebase Realtime Database • Google Vision API</p>
      </footer>
    </div>
  );
}
