module.exports = (length = 1, start = 0) => {
    return Array.from({ length }, (v, i, num = start) => num + i);
};
