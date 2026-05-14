import React, { useState, useEffect } from 'react';
import { documentAPI } from '../utils/api';
import '../styles/uploadHistory.css';

const UploadHistory = ({ refreshTrigger = 0, selectedLabel = null, onLabelChange = null }) => {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [allLabels, setAllLabels] = useState([]);
  const [labelCounts, setLabelCounts] = useState({});

  useEffect(() => {
    fetchHistory();
  }, [refreshTrigger]);

  useEffect(() => {
    if (page > 1) {
      fetchHistory();
    }
  }, [page]);

  const fetchHistory = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await documentAPI.getHistory({ page, limit: 100 });
      const allUploads = response.data.data.uploads || [];
      
      // Extract unique labels and count them
      const labels = {};
      const counts = {};
      
      allUploads.forEach((upload) => {
        if (upload.label && upload.label !== 'Unknown') {
          if (!labels[upload.label]) {
            labels[upload.label] = true;
            counts[upload.label] = 0;
          }
          counts[upload.label]++;
        }
      });

      setAllLabels(Object.keys(labels).sort());
      setLabelCounts(counts);
      
      // Filter by selected label if any
      const filteredUploads = selectedLabel 
        ? allUploads.filter((upload) => upload.label === selectedLabel)
        : allUploads;

      setHistory(filteredUploads);
      setTotalPages(response.data.data.pagination?.totalPages || 1);
    } catch (err) {
      const errorMessage = err.response?.data?.message || 'Failed to load upload history';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (history.length > 0 && page === 1) {
      // Re-filter when selected label changes
      fetchHistory();
    }
  }, [selectedLabel]);

  const handleDelete = async (uploadId) => {
    if (!window.confirm('Are you sure you want to delete this upload?')) {
      return;
    }

    try {
      await documentAPI.deleteDocument(uploadId);
      setHistory((prev) => prev.filter((upload) => upload.id !== uploadId));
      // Refresh to update label counts
      fetchHistory();
    } catch (err) {
      const errorMessage = err.response?.data?.message || 'Failed to delete upload';
      setError(errorMessage);
    }
  };

  const handleView = (uploadId, fileName) => {
    const token = localStorage.getItem('token');
    const viewUrl = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'}/api/uploads/${uploadId}/view?token=${token}`;
    window.open(viewUrl, '_blank');
  };

  const handleDownload = (uploadId, fileName) => {
    const token = localStorage.getItem('token');
    const downloadUrl = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'}/api/uploads/${uploadId}/download`;
    
    fetch(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
    .then(response => response.blob())
    .then(blob => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'document.pdf';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    })
    .catch(err => console.error('Download failed:', err));
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getLabelBadgeClass = (label) => {
    if (!label) return 'label-badge unknown';
    // Convert to lowercase and replace spaces/underscores with hyphens for CSS class matching
    const normalizedLabel = label.toLowerCase().replace(/[\s_]+/g, '-');
    return `label-badge ${normalizedLabel}`;
  };

  const handleLabelFilter = (label) => {
    const newLabel = selectedLabel === label ? null : label;
    onLabelChange?.(newLabel);
  };

  if (error && history.length === 0) {
    return (
      <div className="upload-history-container">
        <div className="error-message">{error}</div>
        <button onClick={fetchHistory} className="retry-btn">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="upload-history-container">
      <div className="history-header">
        <h2>📋 Upload History</h2>
        <button onClick={fetchHistory} className="refresh-btn" disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Label Filter Section */}
      {allLabels.length > 0 && (
        <div className="label-filter-section">
          <h3>Filter by Category</h3>
          <div className="label-filter-buttons">
            <button 
              className={`filter-btn ${selectedLabel === null ? 'active' : ''}`}
              onClick={() => handleLabelFilter(null)}
            >
              All Documents ({Object.values(labelCounts).reduce((a, b) => a + b, 0)})
            </button>
            {allLabels.map((label) => (
              <button
                key={label}
                className={`filter-btn ${selectedLabel === label ? 'active' : ''}`}
                onClick={() => handleLabelFilter(label)}
              >
                <span className={getLabelBadgeClass(label)}>{label}</span>
                <span className="count">({labelCounts[label] || 0})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && history.length === 0 && (
        <div className="loading-message">
          <div className="spinner"></div>
          Loading history...
        </div>
      )}

      {history.length === 0 && !loading && (
        <div className="empty-state">
          <p>{selectedLabel ? `No documents found with label "${selectedLabel}"` : 'No documents uploaded yet. Start by uploading a PDF file!'}</p>
        </div>
      )}

      {history.length > 0 && (
        <>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>File Name</th>
                  <th>Predicted Label</th>
                  <th>Confidence</th>
                  <th>Upload Time</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {history.map((upload) => (
                  <tr key={upload.id} className="history-row">
                    <td className="file-name-cell">
                      <span className="file-icon">📄</span>
                      <button 
                        className="file-link"
                        onClick={() => handleView(upload.id, upload.fileName)}
                        title="View PDF"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#2563eb',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                          font: 'inherit'
                        }}
                      >
                        {upload.fileName}
                      </button>
                    </td>
                    <td className="label-cell">
                      <span className={getLabelBadgeClass(upload.label)}>
                        {upload.label || 'Pending'}
                      </span>
                    </td>
                    <td className="confidence-cell">
                      {upload.confidence ? (
                        <div className="confidence-display">
                          <span className="confidence-value">{(upload.confidence * 100).toFixed(1)}%</span>
                          <div className="confidence-bar">
                            <div 
                              className="confidence-fill"
                              style={{
                                width: `${Math.min(upload.confidence * 100, 100)}%`,
                                backgroundColor: upload.confidence > 0.8 ? '#10b981' : 
                                                upload.confidence > 0.6 ? '#f59e0b' : '#ef4444'
                              }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span style={{color: '#9ca3af'}}>—</span>
                      )}
                    </td>
                    <td className="time-cell">{formatDate(upload.uploadedAt)}</td>
                    <td className="action-cell">
                      <button
                        className="download-btn"
                        onClick={() => handleDownload(upload.id, upload.fileName)}
                        title="Download PDF"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: '1.2em',
                          padding: '0 8px'
                        }}
                      >
                        ⬇️
                      </button>
                      <button
                        className="delete-btn"
                        onClick={() => handleDelete(upload.id)}
                        title="Delete upload"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: '1.2em',
                          padding: '0 8px'
                        }}
                      >
                        🗑️
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="page-btn"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || loading}
              >
                ← Previous
              </button>
              <span className="page-info">
                Page {page} of {totalPages}
              </span>
              <button
                className="page-btn"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages || loading}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {error && history.length > 0 && <div className="error-toast">{error}</div>}
    </div>
  );
};

export default UploadHistory;
