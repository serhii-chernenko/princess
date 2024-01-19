module.exports = {
    getTime() {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Kyiv',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(new Date());
    }
};
