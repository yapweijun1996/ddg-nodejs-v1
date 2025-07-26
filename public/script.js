document.addEventListener('DOMContentLoaded', () => {
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const resultsTextarea = document.getElementById('results-textarea');

  searchForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const query = searchInput.value;

    try {
      const response = await fetch('/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      const results = await response.json();
      resultsTextarea.value = JSON.stringify(results, null, 2);
    } catch (error) {
      resultsTextarea.value = 'An error occurred while fetching the search results.';
    }
  });
});