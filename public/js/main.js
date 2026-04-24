document.addEventListener('DOMContentLoaded', () => {
    fetchNews();
});

async function fetchNews() {
    try {
        const response = await fetch('/api/noticias');
        const data = await response.json();
        
        if(data) {
            renderHero(data.noticiaPrincipal);
            renderFeed(data.noticiasSecundarias);
        }
    } catch (error) {
        console.error('Error fetching news:', error);
        document.getElementById('hero-container').innerHTML = '<p style="padding:20px;">Error cargando noticias.</p>';
    }
}

function renderHero(noticia) {
    const heroHTML = `
        <article class="hero-card">
            <div class="hero-img-wrapper">
                <img src="${noticia.imagen}" alt="Hero Image">
                <div class="hero-gradient">
                    <h2 class="hero-title">${noticia.titulo}</h2>
                    <div class="hero-meta">
                        <span class="tag">${noticia.categoria}</span>
                        <span>•</span>
                        <span>${noticia.tiempo}</span>
                        <span>•</span>
                        <span>${noticia.vistas} vistas</span>
                        <span>•</span>
                        <span>${noticia.comentarios} comentarios</span>
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
            <article class="news-card">
                <img class="news-thumb" src="${noticia.imagen}" alt="${noticia.categoria}">
                <div class="news-info">
                    <h3 class="news-title">${noticia.titulo}</h3>
                    <div class="news-bottom">
                        <div class="news-meta">
                            <span>${noticia.tiempo}</span>
                            <span>• ${noticia.vistas}</span>
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
