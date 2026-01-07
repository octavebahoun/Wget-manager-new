// options.js

// Sauvegarder les options
function saveOptions() {
    const serverUrl = document.getElementById('serverUrl').value.replace(/\/$/, ''); // Remove trailing slash

    chrome.storage.local.set(
        { serverUrl: serverUrl },
        () => {
            const status = document.getElementById('status');
            status.textContent = 'Options enregistrées !';
            status.className = 'success visible';

            setTimeout(() => {
                status.className = '';
            }, 2000);
        }
    );
}

// Restaurer les options
function restoreOptions() {
    chrome.storage.local.get(
        { serverUrl: 'http://localhost:3000' }, // Valeur par défaut
        (items) => {
            document.getElementById('serverUrl').value = items.serverUrl;
        }
    );
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
