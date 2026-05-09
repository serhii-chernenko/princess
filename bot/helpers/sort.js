module.exports = async players => {
    const sorted = [
        ...players.sort((a, b) => (a.score.score < b.score.score ? 1 : -1))
    ];

    if (sorted.length > 10) {
        sorted.length = 10;
    }

    return sorted;
};
