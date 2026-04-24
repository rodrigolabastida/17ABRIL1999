let globalArticles = []; // Para acceder a ellos rápido al hacer click
let currentGeoPolled = false;

document.addEventListener('DOMContentLoaded', () => {
    checkLocationPermission();
});

function checkLocationPermission() {
    const locPref = localStorage.getItem('intlax_loc_pref');
    if (locPref === 'granted') {
        getLocationAndFetch();
    } else if (locPref === 'denied') {
        fetchNews(); // Fetch sin params (Mayor vistas)
    } else {
        // Mostrar modal pidiendo permiso
        document.getElementById('location-modal-overlay').classList.remove('hidden');
    }
}

// Location Modal Buttons
document.getElementById('btn-allow-loc').addEventListener('click', () => {
    document.getElementById('location-modal-overlay').classList.add('hidden');
    localStorage.setItem('intlax_loc_pref', 'granted');
    getLocationAndFetch();
});

document.getElementById('btn-deny-loc').addEventListener('click', () => {
    document.getElementById('location-modal-overlay').classList.add('hidden');
    localStorage.setItem('intlax_loc_pref', 'denied');
    fetchNews(); 
});

function getLocationAndFetch() {
    if (navigator.geolocation && !currentGeoPolled) {
        currentGeoPolled = true; // prevent loop locks
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                fetchNews(`?lat=${lat}&lng=${lng}`);
            },
            (err) => {
                console.warn('Geolocation Error', err);
                fetchNews(); // Fallback si falla
            }
        );
    } else {
        fetchNews();
    }
}

async function fetchNews(queryParams = '') {
    try {
        const response = await fetch(`/api/feed${queryParams}`);
        const data = await response.json();
        
        if (data.noticiaPrincipal || data.noticiasSecundarias) {
            // Guardamos local para los modales
            globalArticles = [];
            if(data.noticiaPrincipal) globalArticles.push(data.noticiaPrincipal);
            if(data.noticiasSecundarias) globalArticles.push(...data.noticiasSecundarias);
            
            if(data.noticiaPrincipal){
                renderHero(data.noticiaPrincipal);
            } else {
                document.getElementById('hero-container').innerHTML = '';
            }
            renderFeed(data.noticiasSecundarias || []);
            
            attachClickBindings();
        }
    } catch (error) {
        console.error('Error fetching news:', error);
        document.getElementById('hero-container').innerHTML = '<p style="padding:20px;">Error cargando feed RSS.</p>';
    }
}

function renderHero(noticia) {
    const heroHTML = `
        <article class="hero-card" data-id="${noticia.id}">
            <div class="hero-img-wrapper">
                <img src="${noticia.image}" alt="${noticia.source}">
                <div class="hero-gradient">
                    <h2 class="hero-title">${noticia.title}</h2>
                    <div class="hero-meta">
                        <span class="tag">${noticia.category}</span>
                        <span>•</span>
                        <span>${noticia.time}</span>
                        <span>•</span>
                        <span>${(noticia.views/1000).toFixed(1)}K vistas</span>
                    </div>
                </div>
            </div>
        </article>
    `;
    document.getElementById('hero-container').innerHTML = heroHTML;
}

function renderFeed(noticias) {
    const feedContainer = document.getElementById('feed-container');
    let feedHTML = '';
    
    noticias.forEach(noticia => {
        feedHTML += `
            <article class="news-card" data-id="${noticia.id}">
                <img class="news-thumb" src="${noticia.image}" alt="${noticia.source}">
                <div class="news-info">
                    <h3 class="news-title">${noticia.title}</h3>
                    <div class="news-bottom">
                        <div class="news-meta">
                            <span>${noticia.category}</span>
                            <span>• ${(noticia.views/1000).toFixed(1)}K vistas</span>
                        </div>
                        <div class="news-actions">
                            <i class='bx bx-message-rounded'></i>
                            <i class='bx bx-share-alt' ></i>
                        </div>
                    </div>
                </div>
            </article>
        `;
    });
    
    feedContainer.innerHTML = feedHTML;
}

// Modals Logic
let activeArticleLink = '';

function attachClickBindings() {
    const cards = document.querySelectorAll('.hero-card, .news-card');
    cards.forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-id');
            const article = globalArticles.find(a => a.id === id);
            if(article) openSummaryModal(article);
        });
    });
}

function openSummaryModal(article) {
    document.getElementById('summary-img').src = article.image;
    document.getElementById('summary-source').textContent = article.source;
    document.getElementById('summary-title').textContent = article.title;
    document.getElementById('summary-desc').textContent = article.summary;
    activeArticleLink = article.link;
    document.getElementById('btn-open-external').href = article.link;
    
    // Switch Views
    document.getElementById('article-summary-modal').classList.remove('hidden');
}

// Botones dentro de los modales
document.getElementById('close-summary-btn').addEventListener('click', () => {
    document.getElementById('article-summary-modal').classList.add('hidden');
});

document.getElementById('btn-read-full').addEventListener('click', () => {
    // Abrir iframe y esconder resumen
    document.getElementById('article-summary-modal').classList.add('hidden');
    document.getElementById('news-iframe').src = activeArticleLink;
    document.getElementById('iframe-modal').classList.remove('hidden');
});

document.getElementById('close-iframe-btn').addEventListener('click', () => {
    // Cerrar iframe
    document.getElementById('iframe-modal').classList.add('hidden');
    document.getElementById('news-iframe').src = ""; // Stop loading or video
});
